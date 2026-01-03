import { Router, Request, Response } from 'express';
import { getReviewsPrisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  createReviewSchema,
  updateReviewSchema,
  reviewQuerySchema,
  addImageSchema,
  voteSchema,
  createReportSchema,
  vendorResponseSchema,
  verifyReviewSchema,
} from '../schemas/review.schema.js';

const router: Router = Router();
const prisma = getReviewsPrisma();

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
    const starRating = Math.round(s.rating / 10); // Convert 10-50 to 1-5
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
      averageRating: avgRating / 10, // Convert to 1-5 scale
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

// Create review
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = createReviewSchema.parse(req.body);

    // Check if user already reviewed this product
    const existingReview = await prisma.review.findFirst({
      where: {
        productId: data.productId,
        userId: req.user!.userId,
      },
    });

    if (existingReview) {
      res.status(400).json({ error: 'You have already reviewed this product' });
      return;
    }

    // Check for verified purchase
    let verifiedPurchase = false;
    if (data.orderId) {
      // In production, verify order via order-service
      verifiedPurchase = true;
    }

    const review = await prisma.review.create({
      data: {
        productId: data.productId,
        productVariantId: data.productVariantId,
        userId: req.user!.userId,
        displayName: data.displayName,
        title: data.title,
        body: data.body,
        rating: data.rating,
        verifiedPurchase,
        orderId: data.orderId,
        pros: data.pros,
        cons: data.cons,
        status: 'PENDING',
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
      include: {
        images: true,
        verification: true,
      },
    });

    // If verified, create verification record
    if (verifiedPurchase && data.orderId) {
      await prisma.reviewVerification.create({
        data: {
          reviewId: review.id,
          method: 'ORDER_MATCH',
          orderId: data.orderId,
          verifiedBy: 'system',
          actorType: 'SYSTEM',
          createdBy: 'system',
        },
      });
    }

    res.status(201).json(review);
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      res.status(400).json({ error: 'Validation error', details: error });
      return;
    }
    console.error('Error creating review:', error);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// List reviews
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const query = reviewQuerySchema.parse(req.query);
    const { page, limit, status, rating, verifiedOnly, sortBy } = query;

    const where: Record<string, unknown> = {};
    
    // Non-admin users can only see approved reviews
    if (!req.user?.roles.includes('admin')) {
      where.status = 'APPROVED';
    } else if (status) {
      where.status = status;
    }

    if (rating) {
      // Convert 1-5 star rating to 10-50 range
      where.rating = {
        gte: rating * 10,
        lt: (rating + 1) * 10,
      };
    }
    if (verifiedOnly) where.verifiedPurchase = true;

    const orderBy: Record<string, string> = {};
    switch (sortBy) {
      case 'newest': orderBy.createdAt = 'desc'; break;
      case 'oldest': orderBy.createdAt = 'asc'; break;
      case 'highest': orderBy.rating = 'desc'; break;
      case 'lowest': orderBy.rating = 'asc'; break;
      case 'helpful': orderBy.helpfulCount = 'desc'; break;
    }

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          images: true,
          vendorResponse: true,
          _count: {
            select: { votes: true, reports: true },
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
    console.error('Error listing reviews:', error);
    res.status(500).json({ error: 'Failed to list reviews' });
  }
});

// Get review by ID
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const review = await prisma.review.findUnique({
      where: { id },
      include: {
        images: true,
        verification: true,
        vendorResponse: true,
        _count: {
          select: { votes: true, reports: true },
        },
      },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    // Non-admin users can only see approved reviews (or their own)
    if (review.status !== 'APPROVED' && 
        review.userId !== req.user?.userId && 
        !req.user?.roles.includes('admin')) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    res.json(review);
  } catch (error) {
    console.error('Error getting review:', error);
    res.status(500).json({ error: 'Failed to get review' });
  }
});

// Get reviews for a product
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const query = reviewQuerySchema.parse(req.query);
    const { page, limit, rating, verifiedOnly, sortBy } = query;

    const where: Record<string, unknown> = {
      productId,
      status: 'APPROVED',
    };

    if (rating) {
      where.rating = {
        gte: rating * 10,
        lt: (rating + 1) * 10,
      };
    }
    if (verifiedOnly) where.verifiedPurchase = true;

    const orderBy: Record<string, string> = {};
    switch (sortBy) {
      case 'newest': orderBy.createdAt = 'desc'; break;
      case 'oldest': orderBy.createdAt = 'asc'; break;
      case 'highest': orderBy.rating = 'desc'; break;
      case 'lowest': orderBy.rating = 'asc'; break;
      case 'helpful': orderBy.helpfulCount = 'desc'; break;
    }

    const [reviews, total, stats] = await Promise.all([
      prisma.review.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          images: true,
          vendorResponse: true,
        },
      }),
      prisma.review.count({ where }),
      prisma.productReviewStats.findUnique({
        where: { productId },
      }),
    ]);

    res.json({
      data: reviews,
      stats,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error getting product reviews:', error);
    res.status(500).json({ error: 'Failed to get product reviews' });
  }
});

// Get reviews by user
router.get('/user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const query = reviewQuerySchema.parse(req.query);
    const { page, limit } = query;

    // Users can only see their own reviews (unless admin)
    if (userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const where: Record<string, unknown> = { userId };

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          images: true,
          vendorResponse: true,
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
    console.error('Error getting user reviews:', error);
    res.status(500).json({ error: 'Failed to get user reviews' });
  }
});

// Update review
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);
    const data = updateReviewSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    // Only author can update (admin can use moderation endpoints)
    if (review.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Put review back in pending if edited
    const updated = await prisma.review.update({
      where: { id },
      data: {
        ...data,
        status: 'PENDING',
        updatedBy: req.user!.userId,
      },
      include: {
        images: true,
      },
    });

    res.json(updated);
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      res.status(400).json({ error: 'Validation error', details: error });
      return;
    }
    console.error('Error updating review:', error);
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// Delete review
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const review = await prisma.review.findUnique({
      where: { id },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    // Author or admin can delete
    if (review.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.review.delete({
      where: { id },
    });

    // Update stats
    await updateProductStats(review.productId);

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// =====================
// IMAGES
// =====================

router.post('/:id/images', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const data = addImageSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    if (review.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const image = await prisma.reviewImage.create({
      data: {
        reviewId,
        ...data,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
    });

    res.status(201).json(image);
  } catch (error) {
    console.error('Error adding image:', error);
    res.status(500).json({ error: 'Failed to add image' });
  }
});

router.delete('/:id/images/:imageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const imageId = parseInt(req.params.imageId!);

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    if (review.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.reviewImage.delete({
      where: { id: imageId },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// =====================
// VOTING
// =====================

router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const { voteType } = voteSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review || review.status !== 'APPROVED') {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    // Can't vote on own review
    if (review.userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot vote on your own review' });
      return;
    }

    const existingVote = await prisma.reviewVote.findUnique({
      where: {
        reviewId_userId: {
          reviewId,
          userId: req.user!.userId,
        },
      },
    });

    if (existingVote) {
      // Update vote
      await prisma.reviewVote.update({
        where: { id: existingVote.id },
        data: { voteType, updatedBy: req.user!.userId },
      });

      // Update counts
      const helpfulDelta = existingVote.voteType === 'HELPFUL' ? -1 : (voteType === 'HELPFUL' ? 1 : 0);
      const notHelpfulDelta = existingVote.voteType === 'NOT_HELPFUL' ? -1 : (voteType === 'NOT_HELPFUL' ? 1 : 0);

      await prisma.review.update({
        where: { id: reviewId },
        data: {
          helpfulCount: { increment: helpfulDelta },
          notHelpfulCount: { increment: notHelpfulDelta },
        },
      });
    } else {
      // Create vote
      await prisma.reviewVote.create({
        data: {
          reviewId,
          userId: req.user!.userId,
          voteType,
          createdBy: req.user!.userId,
          updatedBy: req.user!.userId,
        },
      });

      // Update counts
      await prisma.review.update({
        where: { id: reviewId },
        data: {
          helpfulCount: voteType === 'HELPFUL' ? { increment: 1 } : undefined,
          notHelpfulCount: voteType === 'NOT_HELPFUL' ? { increment: 1 } : undefined,
        },
      });
    }

    res.json({ message: 'Vote recorded' });
  } catch (error) {
    console.error('Error voting:', error);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

router.delete('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);

    const vote = await prisma.reviewVote.findUnique({
      where: {
        reviewId_userId: {
          reviewId,
          userId: req.user!.userId,
        },
      },
    });

    if (!vote) {
      res.status(404).json({ error: 'Vote not found' });
      return;
    }

    await prisma.reviewVote.delete({
      where: { id: vote.id },
    });

    // Update counts
    await prisma.review.update({
      where: { id: reviewId },
      data: {
        helpfulCount: vote.voteType === 'HELPFUL' ? { decrement: 1 } : undefined,
        notHelpfulCount: vote.voteType === 'NOT_HELPFUL' ? { decrement: 1 } : undefined,
      },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error removing vote:', error);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

// =====================
// REPORTS
// =====================

router.post('/:id/report', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const data = createReportSchema.parse(req.body);

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const report = await prisma.reviewReport.create({
      data: {
        reviewId,
        reporterId: req.user!.userId,
        reason: data.reason,
        details: data.details,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
    });

    // Increment report count
    await prisma.review.update({
      where: { id: reviewId },
      data: { reportCount: { increment: 1 } },
    });

    res.status(201).json(report);
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// =====================
// VENDOR RESPONSE
// =====================

router.post('/:id/response', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const { body } = vendorResponseSchema.parse(req.body);

    // Only vendors/admins can respond
    if (!req.user!.roles.includes('vendor') && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Only vendors can respond to reviews' });
      return;
    }

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const response = await prisma.vendorResponse.create({
      data: {
        reviewId,
        body,
        responderId: req.user!.userId,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
    });

    res.status(201).json(response);
  } catch (error) {
    console.error('Error creating response:', error);
    res.status(500).json({ error: 'Failed to create response' });
  }
});

router.put('/:id/response', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const { body } = vendorResponseSchema.parse(req.body);

    const existingResponse = await prisma.vendorResponse.findUnique({
      where: { reviewId },
    });

    if (!existingResponse) {
      res.status(404).json({ error: 'Response not found' });
      return;
    }

    // Only original responder or admin can update
    if (existingResponse.responderId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const response = await prisma.vendorResponse.update({
      where: { reviewId },
      data: {
        body,
        updatedBy: req.user!.userId,
      },
    });

    res.json(response);
  } catch (error) {
    console.error('Error updating response:', error);
    res.status(500).json({ error: 'Failed to update response' });
  }
});

router.delete('/:id/response', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);

    const existingResponse = await prisma.vendorResponse.findUnique({
      where: { reviewId },
    });

    if (!existingResponse) {
      res.status(404).json({ error: 'Response not found' });
      return;
    }

    // Only original responder or admin can delete
    if (existingResponse.responderId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.vendorResponse.delete({
      where: { reviewId },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting response:', error);
    res.status(500).json({ error: 'Failed to delete response' });
  }
});

// =====================
// VERIFICATION
// =====================

router.post('/:id/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const reviewId = parseInt(req.params.id!);
    const data = verifyReviewSchema.parse(req.body);

    // Only admins can manually verify
    if (!req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const review = await prisma.review.findUnique({
      where: { id: reviewId },
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const verification = await prisma.reviewVerification.upsert({
      where: { reviewId },
      create: {
        reviewId,
        method: data.method,
        orderId: data.orderId,
        orderItemId: data.orderItemId,
        purchasedAt: data.purchasedAt,
        receiptUrl: data.receiptUrl,
        externalSource: data.externalSource,
        metadata: data.metadata,
        verifiedBy: req.user!.userId,
        actorUserId: req.user!.userId,
        actorType: 'ADMIN',
        createdBy: req.user!.userId,
      },
      update: {
        method: data.method,
        orderId: data.orderId,
        orderItemId: data.orderItemId,
        purchasedAt: data.purchasedAt,
        receiptUrl: data.receiptUrl,
        externalSource: data.externalSource,
        metadata: data.metadata,
        verifiedBy: req.user!.userId,
      },
    });

    await prisma.review.update({
      where: { id: reviewId },
      data: {
        verifiedPurchase: true,
        orderId: data.orderId || review.orderId,
      },
    });

    res.json(verification);
  } catch (error) {
    console.error('Error verifying review:', error);
    res.status(500).json({ error: 'Failed to verify review' });
  }
});

export default router;
