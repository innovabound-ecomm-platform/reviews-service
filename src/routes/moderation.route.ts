import { Router, Request, Response } from 'express';
import { getReviewsPrisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  moderationActionSchema,
  moderationQueueQuerySchema,
  resolveReportSchema,
} from '../schemas/review.schema.js';
import {
  getSiteId,
  requireSiteId,
  reviewWhere,
  withSiteId,
} from '../utils/tenant.utils.js';

const router: Router = Router();
const prisma = getReviewsPrisma();

// Helper to update product review stats
async function updateProductStats(productId: string, siteId: string) {
  const stats = await prisma.review.groupBy({
    by: ['rating'],
    where: reviewWhere(siteId, { productId, status: 'APPROVED' }),
    _count: true,
  });

  const verifiedStats = await prisma.review.aggregate({
    where: reviewWhere(siteId, { productId, status: 'APPROVED', verifiedPurchase: true }),
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
    where: { siteId_productId: { siteId, productId } },
    create: {
      productId,
      siteId,
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

/**
 * @openapi
 * /reviews/moderation/queue:
 *   get:
 *     summary: Get moderation queue
 *     description: Retrieve reviews pending moderation. Shows pending and flagged reviews sorted by report count. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, FLAGGED, APPROVED, REJECTED, REMOVED]
 *     responses:
 *       200:
 *         description: Moderation queue
 *       403:
 *         description: Admin/moderator access required
 *       500:
 *         description: Server error
 */
// Get moderation queue
router.get('/queue', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const query = moderationQueueQuerySchema.parse(req.query);
    const { page, limit, status } = query;

    const additionalWhere: Record<string, unknown> = {};
    
    if (status) {
      additionalWhere.status = status;
    } else {
      // Default to pending and flagged
      additionalWhere.status = { in: ['PENDING', 'FLAGGED'] };
    }

    const where = reviewWhere(siteId, additionalWhere, { strict: false });

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

/**
 * @openapi
 * /reviews/moderation/{id}/approve:
 *   post:
 *     summary: Approve review
 *     description: Approve a pending/flagged review for publication. Updates product stats. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Review approved
 *       403:
 *         description: Admin/moderator access required
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Approve review
router.post('/:id/approve', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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
      data: withSiteId({
        reviewId: id,
        action: 'APPROVE',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'APPROVED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      }, siteId),
    });

    // Update product stats
    await updateProductStats(review.productId, siteId);

    res.json(updated);
  } catch (error) {
    console.error('Error approving review:', error);
    res.status(500).json({ error: 'Failed to approve review' });
  }
});

/**
 * @openapi
 * /reviews/moderation/{id}/reject:
 *   post:
 *     summary: Reject review
 *     description: Reject a review permanently. Review will not be published. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Review rejected
 *       403:
 *         description: Admin/moderator access required
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Reject review
router.post('/:id/reject', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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
      data: withSiteId({
        reviewId: id,
        action: 'REJECT',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'REJECTED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      }, siteId),
    });

    res.json(updated);
  } catch (error) {
    console.error('Error rejecting review:', error);
    res.status(500).json({ error: 'Failed to reject review' });
  }
});

/**
 * @openapi
 * /reviews/moderation/{id}/flag:
 *   post:
 *     summary: Flag review for additional review
 *     description: Flag a review that needs additional moderation review. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Review flagged
 *       403:
 *         description: Admin/moderator access required
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Flag review for additional review
router.post('/:id/flag', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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
      data: withSiteId({
        reviewId: id,
        action: 'FLAG',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'FLAGGED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      }, siteId),
    });

    res.json(updated);
  } catch (error) {
    console.error('Error flagging review:', error);
    res.status(500).json({ error: 'Failed to flag review' });
  }
});

/**
 * @openapi
 * /reviews/moderation/{id}/remove:
 *   post:
 *     summary: Remove published review
 *     description: Remove a published review from public view. Updates product stats. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Review removed
 *       403:
 *         description: Admin/moderator access required
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Remove published review
router.post('/:id/remove', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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
      data: withSiteId({
        reviewId: id,
        action: 'REMOVE',
        moderatorId: req.user!.userId,
        reason,
        previousStatus,
        newStatus: 'REMOVED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      }, siteId),
    });

    // Update product stats
    if (previousStatus === 'APPROVED') {
      await updateProductStats(review.productId, siteId);
    }

    res.json(updated);
  } catch (error) {
    console.error('Error removing review:', error);
    res.status(500).json({ error: 'Failed to remove review' });
  }
});

/**
 * @openapi
 * /reviews/moderation/{id}/restore:
 *   post:
 *     summary: Restore removed review
 *     description: Restore a previously removed review and approve it. Updates product stats. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Review restored
 *       400:
 *         description: Only removed reviews can be restored
 *       403:
 *         description: Admin/moderator access required
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Restore removed review
router.post('/:id/restore', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const { reason } = moderationActionSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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
      data: withSiteId({
        reviewId: id,
        action: 'RESTORE',
        moderatorId: req.user!.userId,
        reason,
        previousStatus: 'REMOVED',
        newStatus: 'APPROVED',
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      }, siteId),
    });

    // Update product stats
    await updateProductStats(review.productId, siteId);

    res.json(updated);
  } catch (error) {
    console.error('Error restoring review:', error);
    res.status(500).json({ error: 'Failed to restore review' });
  }
});

/**
 * @openapi
 * /reviews/moderation/{id}/logs:
 *   get:
 *     summary: Get moderation logs
 *     description: Retrieve moderation history for a review. Shows all moderation actions. Admin/moderator only.
 *     tags:
 *       - Moderation
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Moderation logs
 *       403:
 *         description: Admin/moderator access required
 *       500:
 *         description: Server error
 */
// Get moderation logs for a review
router.get('/:id/logs', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const reviewId = parseInt(req.params.id!);

    const where: Record<string, unknown> = { reviewId };
    if (siteId) where.siteId = siteId;

    const logs = await prisma.moderationLog.findMany({
      where,
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

/**
 * @openapi
 * /reviews/moderation/reports:
 *   get:
 *     summary: List review reports
 *     description: Get all reports submitted by users. Filter by resolved status. Admin/moderator only.
 *     tags:
 *       - Moderation Reports
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: resolved
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: List of reports
 *       403:
 *         description: Admin/moderator access required
 *       500:
 *         description: Server error
 */
// List reports
router.get('/reports', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const resolved = req.query.resolved === 'true';

    // ReviewReport doesn't have siteId - filter by review.siteId instead
    const where: Record<string, unknown> = { resolved };
    if (siteId) {
      where.review = { siteId };
    }

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
              siteId: true,
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

/**
 * @openapi
 * /reviews/moderation/reports/{id}/resolve:
 *   post:
 *     summary: Resolve report
 *     description: Mark report as resolved and optionally take action on the review. Admin/moderator only.
 *     tags:
 *       - Moderation Reports
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [dismiss, flag_review, remove_review]
 *     responses:
 *       200:
 *         description: Report resolved
 *       403:
 *         description: Admin/moderator access required
 *       404:
 *         description: Report not found
 *       500:
 *         description: Server error
 */
// Resolve report
router.post('/reports/:id/resolve', requireAuth, requirePermission('admin', 'moderator'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const { action } = resolveReportSchema.parse(req.body);

    const report = await prisma.reviewReport.findFirst({
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
        data: withSiteId({
          reviewId: report.reviewId,
          action: 'REMOVE',
          moderatorId: req.user!.userId,
          reason: `Report resolved: ${report.reason}`,
          previousStatus: report.review.status,
          newStatus: 'REMOVED',
          actorUserId: req.user!.userId,
          actorType: 'ADMIN',
          createdBy: req.user!.userId,
        }, siteId),
      });
    } else if (action === 'flag_review') {
      await prisma.review.update({
        where: { id: report.reviewId },
        data: { status: 'FLAGGED' },
      });

      await prisma.moderationLog.create({
        data: withSiteId({
          reviewId: report.reviewId,
          action: 'FLAG',
          moderatorId: req.user!.userId,
          reason: `Report resolved: ${report.reason}`,
          previousStatus: report.review.status,
          newStatus: 'FLAGGED',
          actorUserId: req.user!.userId,
          actorType: 'ADMIN',
          createdBy: req.user!.userId,
        }, siteId),
      });
    }

    res.json(resolved);
  } catch (error) {
    console.error('Error resolving report:', error);
    res.status(500).json({ error: 'Failed to resolve report' });
  }
});

export default router;
