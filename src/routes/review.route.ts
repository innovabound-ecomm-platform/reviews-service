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
    const starRating = Math.round(s.rating / 10); // Convert 10-50 to 1-5
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

/**
 * @openapi
 * /reviews:
 *   post:
 *     summary: Create a new review
 *     description: Submit a product review. System automatically checks for verified purchase and validates single review per product per user.
 *     tags:
 *       - Reviews
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId, title, body, rating]
 *             properties:
 *               productId:
 *                 type: string
 *               productVariantId:
 *                 type: string
 *               displayName:
 *                 type: string
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               rating:
 *                 type: integer
 *                 minimum: 10
 *                 maximum: 50
 *                 description: Rating in 10-50 range (10=1 star, 50=5 stars)
 *               orderId:
 *                 type: string
 *               pros:
 *                 type: array
 *                 items:
 *                   type: string
 *               cons:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Review created successfully
 *       400:
 *         description: Validation error or duplicate review
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Server error
 */
// Create review
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const data = createReviewSchema.parse(req.body);

    // Check if user already reviewed this product
    const existingReview = await prisma.review.findFirst({
      where: reviewWhere(siteId, {
        productId: data.productId,
        userId: req.user!.userId,
      }),
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
      data: withSiteId({
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
      }, siteId),
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

/**
 * @openapi
 * /reviews:
 *   get:
 *     summary: List reviews
 *     description: Get paginated list of reviews with filtering and sorting options. Non-admin users only see approved reviews.
 *     tags:
 *       - Reviews
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
 *           enum: [PENDING, APPROVED, REJECTED, FLAGGED, REMOVED]
 *       - in: query
 *         name: rating
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 5
 *       - in: query
 *         name: verifiedOnly
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [newest, oldest, highest, lowest, helpful]
 *     responses:
 *       200:
 *         description: Paginated list of reviews
 *       500:
 *         description: Server error
 */
// List reviews
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const query = reviewQuerySchema.parse(req.query);
    const { page, limit, status, rating, verifiedOnly, sortBy } = query;

    const additionalWhere: Record<string, unknown> = {};
    
    // Non-admin users can only see approved reviews
    if (!req.user?.roles.includes('admin')) {
      additionalWhere.status = 'APPROVED';
    } else if (status) {
      additionalWhere.status = status;
    }

    if (rating) {
      // Convert 1-5 star rating to 10-50 range
      additionalWhere.rating = {
        gte: rating * 10,
        lt: (rating + 1) * 10,
      };
    }
    if (verifiedOnly) additionalWhere.verifiedPurchase = true;

    const where = reviewWhere(siteId, additionalWhere, { strict: false });

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

/**
 * @openapi
 * /reviews/{id}:
 *   get:
 *     summary: Get review by ID
 *     description: Retrieve a single review with images, verification, and vendor response. Non-admin users can only see approved reviews or their own.
 *     tags:
 *       - Reviews
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
 *         description: Review details
 *       404:
 *         description: Review not found or not accessible
 *       500:
 *         description: Server error
 */
// Get review by ID
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const id = parseInt(req.params.id!);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }, { strict: false }),
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

/**
 * @openapi
 * /reviews/product/{productId}:
 *   get:
 *     summary: Get reviews for a product
 *     description: Retrieve paginated reviews for a specific product with stats. Only approved reviews are returned.
 *     tags:
 *       - Reviews
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
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
 *         name: rating
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 5
 *       - in: query
 *         name: verifiedOnly
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [newest, oldest, highest, lowest, helpful]
 *     responses:
 *       200:
 *         description: Reviews and stats for product
 *       500:
 *         description: Server error
 */
// Get reviews for a product
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const { productId } = req.params;
    const query = reviewQuerySchema.parse(req.query);
    const { page, limit, rating, verifiedOnly, sortBy } = query;

    const additionalWhere: Record<string, unknown> = {
      productId,
      status: 'APPROVED',
    };

    if (rating) {
      additionalWhere.rating = {
        gte: rating * 10,
        lt: (rating + 1) * 10,
      };
    }
    if (verifiedOnly) additionalWhere.verifiedPurchase = true;

    const where = reviewWhere(siteId, additionalWhere, { strict: false });

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
      siteId
        ? prisma.productReviewStats.findUnique({
            where: { siteId_productId: { siteId, productId: productId! } },
          })
        : prisma.productReviewStats.findFirst({
            where: { productId: productId! },
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

/**
 * @openapi
 * /reviews/user/{userId}:
 *   get:
 *     summary: Get reviews by user
 *     description: Retrieve all reviews written by a specific user. Users can only see their own reviews unless admin.
 *     tags:
 *       - Reviews
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
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
 *     responses:
 *       200:
 *         description: User's reviews
 *       403:
 *         description: Access denied
 *       500:
 *         description: Server error
 */
// Get reviews by user
router.get('/user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const { userId } = req.params;
    const query = reviewQuerySchema.parse(req.query);
    const { page, limit } = query;

    // Users can only see their own reviews (unless admin)
    if (userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const where = reviewWhere(siteId, { userId }, { strict: false });

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

/**
 * @openapi
 * /reviews/{id}:
 *   put:
 *     summary: Update review
 *     description: Update review content. Only author can update. Review status returns to PENDING after edit.
 *     tags:
 *       - Reviews
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
 *             properties:
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               rating:
 *                 type: integer
 *                 minimum: 10
 *                 maximum: 50
 *               pros:
 *                 type: array
 *                 items:
 *                   type: string
 *               cons:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Review updated
 *       400:
 *         description: Validation error
 *       403:
 *         description: Access denied
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Update review
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const data = updateReviewSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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

/**
 * @openapi
 * /reviews/{id}:
 *   delete:
 *     summary: Delete review
 *     description: Permanently delete a review. Author or admin can delete. Updates product stats.
 *     tags:
 *       - Reviews
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
 *       204:
 *         description: Review deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
// Delete review
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id }),
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
    await updateProductStats(review.productId, siteId);

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// =====================
// IMAGES
// =====================

/**
 * @openapi
 * /reviews/{id}/images:
 *   post:
 *     summary: Add image to review
 *     description: Upload an image to an existing review. Only review author can add images.
 *     tags:
 *       - Review Images
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
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *               caption:
 *                 type: string
 *               displayOrder:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Image added
 *       403:
 *         description: Access denied
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
router.post('/:id/images', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const data = addImageSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id: reviewId }),
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
      data: withSiteId({
        reviewId,
        ...data,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      }, siteId),
    });

    res.status(201).json(image);
  } catch (error) {
    console.error('Error adding image:', error);
    res.status(500).json({ error: 'Failed to add image' });
  }
});

/**
 * @openapi
 * /reviews/{id}/images/{imageId}:
 *   delete:
 *     summary: Delete image from review
 *     description: Remove an image from a review. Author or admin can delete.
 *     tags:
 *       - Review Images
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: imageId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       204:
 *         description: Image deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
router.delete('/:id/images/:imageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const imageId = parseInt(req.params.imageId!);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id: reviewId }),
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

/**
 * @openapi
 * /reviews/{id}/vote:
 *   post:
 *     summary: Vote on review
 *     description: Mark review as helpful or not helpful. Cannot vote on own reviews. Updates vote if already voted.
 *     tags:
 *       - Review Voting
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
 *             required: [voteType]
 *             properties:
 *               voteType:
 *                 type: string
 *                 enum: [HELPFUL, NOT_HELPFUL]
 *     responses:
 *       200:
 *         description: Vote recorded
 *       400:
 *         description: Cannot vote on own review
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const { voteType } = voteSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id: reviewId }),
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
        data: withSiteId({
          reviewId,
          userId: req.user!.userId,
          voteType,
          createdBy: req.user!.userId,
          updatedBy: req.user!.userId,
        }, siteId),
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

/**
 * @openapi
 * /reviews/{id}/vote:
 *   delete:
 *     summary: Remove vote from review
 *     description: Remove your vote (helpful/not helpful) from a review.
 *     tags:
 *       - Review Voting
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
 *       204:
 *         description: Vote removed
 *       404:
 *         description: Vote not found
 *       500:
 *         description: Server error
 */
router.delete('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
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

/**
 * @openapi
 * /reviews/{id}/report:
 *   post:
 *     summary: Report a review
 *     description: Submit a report for inappropriate review content. Increments report count.
 *     tags:
 *       - Review Reports
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
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 enum: [SPAM, INAPPROPRIATE, OFFENSIVE, FAKE, OTHER]
 *               details:
 *                 type: string
 *     responses:
 *       201:
 *         description: Report submitted
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
router.post('/:id/report', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const data = createReportSchema.parse(req.body);

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id: reviewId }),
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const report = await prisma.reviewReport.create({
      data: withSiteId({
        reviewId,
        reporterId: req.user!.userId,
        reason: data.reason,
        details: data.details,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      }, siteId),
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

/**
 * @openapi
 * /reviews/{id}/response:
 *   post:
 *     summary: Add vendor response
 *     description: Add a vendor response to a review. Only vendors and admins can respond.
 *     tags:
 *       - Vendor Responses
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
 *             required: [body]
 *             properties:
 *               body:
 *                 type: string
 *     responses:
 *       201:
 *         description: Response created
 *       403:
 *         description: Only vendors can respond
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
router.post('/:id/response', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const { body } = vendorResponseSchema.parse(req.body);

    // Only vendors/admins can respond
    if (!req.user!.roles.includes('vendor') && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Only vendors can respond to reviews' });
      return;
    }

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id: reviewId }),
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const response = await prisma.vendorResponse.create({
      data: withSiteId({
        reviewId,
        body,
        responderId: req.user!.userId,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      }, siteId),
    });

    res.status(201).json(response);
  } catch (error) {
    console.error('Error creating response:', error);
    res.status(500).json({ error: 'Failed to create response' });
  }
});

/**
 * @openapi
 * /reviews/{id}/response:
 *   put:
 *     summary: Update vendor response
 *     description: Update existing vendor response. Only original responder or admin can update.
 *     tags:
 *       - Vendor Responses
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
 *             required: [body]
 *             properties:
 *               body:
 *                 type: string
 *     responses:
 *       200:
 *         description: Response updated
 *       403:
 *         description: Access denied
 *       404:
 *         description: Response not found
 *       500:
 *         description: Server error
 */
router.put('/:id/response', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const { body } = vendorResponseSchema.parse(req.body);

    const existingResponse = await prisma.vendorResponse.findFirst({
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

/**
 * @openapi
 * /reviews/{id}/response:
 *   delete:
 *     summary: Delete vendor response
 *     description: Remove vendor response from review. Only original responder or admin can delete.
 *     tags:
 *       - Vendor Responses
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
 *       204:
 *         description: Response deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Response not found
 *       500:
 *         description: Server error
 */
router.delete('/:id/response', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);

    const existingResponse = await prisma.vendorResponse.findFirst({
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

/**
 * @openapi
 * /reviews/{id}/verify:
 *   post:
 *     summary: Verify review purchase
 *     description: Manually verify a review with purchase information. Admin only.
 *     tags:
 *       - Review Verification
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
 *             required: [method]
 *             properties:
 *               method:
 *                 type: string
 *                 enum: [ORDER_MATCH, RECEIPT_UPLOAD, MANUAL, THIRD_PARTY]
 *               orderId:
 *                 type: string
 *               orderItemId:
 *                 type: string
 *               purchasedAt:
 *                 type: string
 *                 format: date-time
 *               receiptUrl:
 *                 type: string
 *               externalSource:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       200:
 *         description: Review verified
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Review not found
 *       500:
 *         description: Server error
 */
router.post('/:id/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const reviewId = parseInt(req.params.id!);
    const data = verifyReviewSchema.parse(req.body);

    // Only admins can manually verify
    if (!req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const review = await prisma.review.findFirst({
      where: reviewWhere(siteId, { id: reviewId }),
    });

    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }

    const verification = await prisma.reviewVerification.upsert({
      where: { reviewId },
      create: withSiteId({
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
      }, siteId),
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
