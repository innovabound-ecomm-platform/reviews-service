import { Router, Request, Response } from 'express';
import { prisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  moderationActionSchema,
  moderationQueueQuerySchema,
  resolveReportSchema,
} from '../schemas/review.schema';

const router = Router();

// Helper to update product review stats
async function updateProductStats(productId: string) {
  const stats = await prisma.review.groupBy({
    by: ['rating'],
    where: { productId, status: 'APPROVED' },
    _count: true,
  });

  const verifiedStats = await prisma.review.aggregate({
    where: { productId, status: 'APPROVED', verifiedPurchase: true },
    _count: true,
    _avg: { rating: true },
  });

  const totalReviews = stats.reduce((sum, s) => sum + s._count, 0);
  const totalRating = stats.reduce((sum, s) => sum + (s.rating * s._count), 0);
  const avgRating = totalReviews > 0 ? totalRating / totalReviews : 0;

  const ratingCounts = {
    rating1Count: 0,
    rating2Count: 0,
    rating3Count: 0,
    rating4Count: 0,
    rating5Count: 0,
  };

  stats.forEach(s => {
    const starRating = Math.round(s.rating / 10);
    const key = `rating${starRating}Count` as keyof typeof ratingCounts;
    if (key in ratingCounts) {
      ratingCounts[key] = s._count;
    }
  });

  await prisma.productReviewStats.upsert({
    where: { productId },
    create: {
      productId,
      reviewCount: totalReviews,
      averageRating: avgRating / 10,
      ...ratingCounts,
      verifiedCount: verifiedStats._count,
      verifiedAvgRating: (verifiedStats._avg.rating || 0) / 10,
    },
    update: {
      reviewCount: totalReviews,
      averageRating: avgRating / 10,
      ...ratingCounts,
      verifiedCount: verifiedStats._count,
      verifiedAvgRating: (verifiedStats._avg.rating || 0) / 10,
    },
  });
}

// Get moderation queue
router.get('/queue', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const query = moderationQueueQuerySchema.parse(req.query);
    const { page, limit, status } = query;

    const where: Record<string, unknown> = {};
    
    if (status) {
      where.status = status;
    } else {
      // Default to pending and flagged
      where.status = { in: ['PENDING', 'FLAGGED'] };
    }

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [
          { reportCount: 'desc' },
          { createdAt: 'asc' },
        ],
        include: {
          images: true,
          reports: {
            where: { resolved: false },
          },
          moderationLogs: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.review.count({ where }),
    ]);

    res.json({
      data: reviews,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error getting moderation queue:', error);
    res.status(500).json({ error: 'Failed to get moderation queue' });
  }
});

// Approve review
router.post('/:id/approve', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const previousStatus = review.status;

    const updated = await prisma.review.update({
      where: { id },
      data: {
        status: 'APPROVED',
        publishedAt: new Date(),
        updatedBy: req.user!.userId,
      },
    });

    // Log moderation action
    await prisma.moderationLog.create({
      data: {
        reviewId: id,
        action: 'APPROVE',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'APPROVED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      },
    });

    // Update product stats
    await updateProductStats(review.productId);

    res.json(updated);
  } catch (error) {
    console.error('Error approving review:', error);
    res.status(500).json({ error: 'Failed to approve review' });
  }
});

// Reject review
router.post('/:id/reject', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const previousStatus = review.status;

    const updated = await prisma.review.update({
      where: { id },
      data: {
        status: 'REJECTED',
        updatedBy: req.user!.userId,
      },
    });

    // Log moderation action
    await prisma.moderationLog.create({
      data: {
        reviewId: id,
        action: 'REJECT',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'REJECTED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error rejecting review:', error);
    res.status(500).json({ error: 'Failed to reject review' });
  }
});

// Flag review for additional review
router.post('/:id/flag', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const previousStatus = review.status;

    const updated = await prisma.review.update({
      where: { id },
      data: {
        status: 'FLAGGED',
        updatedBy: req.user!.userId,
      },
    });

    // Log moderation action
    await prisma.moderationLog.create({
      data: {
        reviewId: id,
        action: 'FLAG',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'FLAGGED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error flagging review:', error);
    res.status(500).json({ error: 'Failed to flag review' });
  }
});

// Remove published review
router.post('/:id/remove', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const previousStatus = review.status;

    const updated = await prisma.review.update({
      where: { id },
      data: {
        status: 'REMOVED',
        updatedBy: req.user!.userId,
      },
    });

    // Log moderation action
    await prisma.moderationLog.create({
      data: {
        reviewId: id,
        action: 'REMOVE',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'REMOVED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      },
    });

    // Update product stats
    if (previousStatus === 'APPROVED') {
      await updateProductStats(review.productId);
    }

    res.json(updated);
  } catch (error) {
    console.error('Error removing review:', error);
    res.status(500).json({ error: 'Failed to remove review' });
  }
});

// Restore removed review
router.post('/:id/restore', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    if (review.status !== 'REMOVED') {
      res.status(400).json({ error: 'Only removed reviews can be restored' });
      return;
    }

    const updated = await prisma.review.update({
      where: { id },
      data: {
        status: 'APPROVED',
        updatedBy: req.user!.userId,
      },
    });

    // Log moderation action
    await prisma.moderationLog.create({
      data: {
        reviewId: id,
        action: 'RESTORE',
        moderatorId: req.user!.userId,
        reason,
        previousStatus: 'REMOVED',
        newStatus: 'APPROVED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      },
    });

    // Update product stats
    await updateProductStats(review.productId);

    res.json(updated);
  } catch (error) {
    console.error('Error restoring review:', error);
    res.status(500).json({ error: 'Failed to restore review' });
  }
});

// Get moderation logs for a review
router.get('/:id/logs', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id);

    const logs = await prisma.moderationLog.findMany({
      where: { reviewId },
      orderBy: { occurredAt: 'desc' },
    });

    res.json(logs);
  } catch (error) {
    console.error('Error getting moderation logs:', error);
    res.status(500).json({ error: 'Failed to get moderation logs' });
  }
});

// =====================
// REPORTS
// =====================

// List reports
router.get('/reports', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const resolved = req.query.resolved === 'true';

    const where: Record<string, unknown> = { resolved };

    const [reports, total] = await Promise.all([
      prisma.reviewReport.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          review: {
            select: {
              id: true,
              title: true,
              body: true,
              userId: true,
              displayName: true,
              productId: true,
              status: true,
            },
          },
        },
      }),
      prisma.reviewReport.count({ where }),
    ]);

    res.json({
      data: reports,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error listing reports:', error);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// Resolve report
router.post('/reports/:id/resolve', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { action } = resolveReportSchema.parse(req.body);

    const report = await prisma.reviewReport.findUnique({
      where: { id },
      include: { review: true },
    });

    if (!report) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }

    // Update report
    const resolved = await prisma.reviewReport.update({
      where: { id },
      data: {
        resolved: true,
        resolvedBy: req.user!.userId,
        resolvedAt: new Date(),
        updatedBy: req.user!.userId,
      },
    });

    // Apply action
    if (action === 'remove_review') {
      await prisma.review.update({
        where: { id: report.reviewId },
        data: { status: 'REMOVED' },
      });

      await prisma.moderationLog.create({
        data: {
          reviewId: report.reviewId,
          action: 'REMOVE',
          moderatorId: req.user!.userId,
          reason: `Report resolved: ${report.reason}`,
          previousStatus: report.review.status,
          newStatus: 'REMOVED',
          actorUserId: req.user!.userId,
          actorType: 'ADMIN',
          createdBy: req.user!.userId,
        },
      });
    } else if (action === 'flag_review') {
      await prisma.review.update({
        where: { id: report.reviewId },
        data: { status: 'FLAGGED' },
      });

      await prisma.moderationLog.create({
        data: {
          reviewId: report.reviewId,
          action: 'FLAG',
          moderatorId: req.user!.userId,
          reason: `Report resolved: ${report.reason}`,
          previousStatus: report.review.status,
          newStatus: 'FLAGGED',
          actorUserId: req.user!.userId,
          actorType: 'ADMIN',
          createdBy: req.user!.userId,
        },
      });
    }

    res.json(resolved);
  } catch (error) {
    console.error('Error resolving report:', error);
    res.status(500).json({ error: 'Failed to resolve report' });
  }
});

export default router;
