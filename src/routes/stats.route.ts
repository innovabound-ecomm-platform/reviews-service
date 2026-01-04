import { Router, Request, Response } from 'express';
import { getReviewsPrisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, requirePermission, optionalAuth } from '../middleware/auth.js';
import {
  getSiteId,
  requireSiteId,
  reviewWhere,
  questionWhere,
} from '../utils/tenant.utils.js';

const router: Router = Router();
const prisma = getReviewsPrisma();

/**
 * @openapi
 * /reviews/stats/product/{productId}:
 *   get:
 *     summary: Get product review statistics
 *     description: Retrieve aggregated review stats for a product including rating distribution and Q&A counts.
 *     tags:
 *       - Statistics
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product review statistics
 *       500:
 *         description: Server error
 */
// Get product review stats
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const { productId } = req.params;

    const stats = siteId
      ? await prisma.productReviewStats.findUnique({
          where: { siteId_productId: { siteId, productId: productId! } },
        })
      : await prisma.productReviewStats.findFirst({
          where: { productId },
        });

    if (!stats) {
      // Return default stats if none exist
      res.json({
        productId,
        reviewCount: 0,
        averageRating: 0,
        rating1Count: 0,
        rating2Count: 0,
        rating3Count: 0,
        rating4Count: 0,
        rating5Count: 0,
        verifiedCount: 0,
        verifiedAvgRating: 0,
        questionCount: 0,
        answeredCount: 0,
      });
      return;
    }

    res.json(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * @openapi
 * /reviews/stats/product/{productId}/recalculate:
 *   post:
 *     summary: Recalculate product statistics
 *     description: Force recalculation of all review and Q&A statistics for a product. Admin only.
 *     tags:
 *       - Statistics
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Statistics recalculated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Server error
 */
// Recalculate product stats (admin)
router.post('/product/:productId/recalculate', requireAuth, requirePermission('admin'), async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const productId = req.params.productId!;

    // Calculate review stats
    const reviewStats = await prisma.review.groupBy({
      by: ['rating'],
      where: reviewWhere(siteId, { productId, status: 'APPROVED' }),
      _count: true,
    });

    const verifiedStats = await prisma.review.aggregate({
      where: reviewWhere(siteId, { productId, status: 'APPROVED', verifiedPurchase: true }),
      _count: true,
      _avg: { rating: true },
    });

    const totalReviews = reviewStats.reduce((sum, s) => sum + s._count, 0);
    const totalRating = reviewStats.reduce((sum, s) => sum + (s.rating * s._count), 0);
    const avgRating = totalReviews > 0 ? totalRating / totalReviews : 0;

    const ratingCounts = {
      rating1Count: 0,
      rating2Count: 0,
      rating3Count: 0,
      rating4Count: 0,
      rating5Count: 0,
    };

    reviewStats.forEach(s => {
      const starRating = Math.round(s.rating / 10);
      const key = `rating${starRating}Count` as keyof typeof ratingCounts;
      if (key in ratingCounts) {
        ratingCounts[key] = s._count;
      }
    });

    // Calculate Q&A stats
    const [questionCount, answeredCount] = await Promise.all([
      prisma.question.count({ where: questionWhere(siteId, { productId }) }),
      prisma.question.count({ where: questionWhere(siteId, { productId, status: 'ANSWERED' }) }),
    ]);

    // Upsert stats
    const stats = await prisma.productReviewStats.upsert({
      where: { siteId_productId: { siteId, productId } },
      create: {
        productId,
        siteId,
        reviewCount: totalReviews,
        averageRating: avgRating / 10,
        ...ratingCounts,
        verifiedCount: verifiedStats._count,
        verifiedAvgRating: (verifiedStats._avg.rating || 0) / 10,
        questionCount,
        answeredCount,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
      update: {
        reviewCount: totalReviews,
        averageRating: avgRating / 10,
        ...ratingCounts,
        verifiedCount: verifiedStats._count,
        verifiedAvgRating: (verifiedStats._avg.rating || 0) / 10,
        questionCount,
        answeredCount,
        updatedBy: req.user!.userId,
      },
    });

    res.json(stats);
  } catch (error) {
    console.error('Error recalculating stats:', error);
    res.status(500).json({ error: 'Failed to recalculate stats' });
  }
});

/**
 * @openapi
 * /reviews/stats/products:
 *   post:
 *     summary: Get statistics for multiple products
 *     description: Bulk retrieve review stats for up to 100 products. Returns default stats for products without reviews.
 *     tags:
 *       - Statistics
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productIds]
 *             properties:
 *               productIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 100
 *     responses:
 *       200:
 *         description: Array of product statistics
 *       400:
 *         description: Invalid request or too many products
 *       500:
 *         description: Server error
 */
// Get stats for multiple products
router.post('/products', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const { productIds } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      res.status(400).json({ error: 'Product IDs array is required' });
      return;
    }

    if (productIds.length > 100) {
      res.status(400).json({ error: 'Maximum 100 products per request' });
      return;
    }

    const where: Record<string, unknown> = { productId: { in: productIds } };
    if (siteId) where.siteId = siteId;

    const stats = await prisma.productReviewStats.findMany({
      where,
    });

    // Create a map for easy lookup
    const statsMap = new Map(stats.map(s => [s.productId, s]));

    // Return stats for all requested products, with defaults for missing ones
    const result = productIds.map(productId => {
      const existing = statsMap.get(productId);
      if (existing) return existing;

      return {
        productId,
        reviewCount: 0,
        averageRating: 0,
        rating1Count: 0,
        rating2Count: 0,
        rating3Count: 0,
        rating4Count: 0,
        rating5Count: 0,
        verifiedCount: 0,
        verifiedAvgRating: 0,
        questionCount: 0,
        answeredCount: 0,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * @openapi
 * /reviews/stats/top-rated:
 *   get:
 *     summary: Get top rated products
 *     description: Retrieve products with highest average ratings, filtered by minimum review count.
 *     tags:
 *       - Statistics
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: minReviews
 *         schema:
 *           type: integer
 *           default: 5
 *     responses:
 *       200:
 *         description: List of top rated products
 *       500:
 *         description: Server error
 */
// Get top rated products
router.get('/top-rated', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const limit = parseInt(req.query.limit as string) || 10;
    const minReviews = parseInt(req.query.minReviews as string) || 5;

    const where: Record<string, unknown> = {
      reviewCount: { gte: minReviews },
    };
    if (siteId) where.siteId = siteId;

    const stats = await prisma.productReviewStats.findMany({
      where,
      orderBy: { averageRating: 'desc' },
      take: limit,
    });

    res.json(stats);
  } catch (error) {
    console.error('Error getting top rated:', error);
    res.status(500).json({ error: 'Failed to get top rated products' });
  }
});

/**
 * @openapi
 * /reviews/stats/summary:
 *   get:
 *     summary: Get overall review statistics
 *     description: Get system-wide statistics for reviews, questions, and moderation. Admin only.
 *     tags:
 *       - Statistics
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Summary statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reviews:
 *                   type: object
 *                 questions:
 *                   type: object
 *                 moderation:
 *                   type: object
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Server error
 */
// Get review statistics summary (admin)
router.get('/summary', requireAuth, requirePermission('admin'), async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    
    const reviewWhereSite = siteId ? { siteId } : {};
    const reportWhereSite = siteId ? { siteId } : {};
    const questionWhereSite = siteId ? { siteId } : {};

    const [
      totalReviews,
      pendingReviews,
      approvedReviews,
      rejectedReviews,
      flaggedReviews,
      totalQuestions,
      answeredQuestions,
      unresolvedReports,
    ] = await Promise.all([
      prisma.review.count({ where: reviewWhereSite }),
      prisma.review.count({ where: { ...reviewWhereSite, status: 'PENDING' } }),
      prisma.review.count({ where: { ...reviewWhereSite, status: 'APPROVED' } }),
      prisma.review.count({ where: { ...reviewWhereSite, status: 'REJECTED' } }),
      prisma.review.count({ where: { ...reviewWhereSite, status: 'FLAGGED' } }),
      prisma.question.count({ where: questionWhereSite }),
      prisma.question.count({ where: { ...questionWhereSite, status: 'ANSWERED' } }),
      prisma.reviewReport.count({ where: { ...reportWhereSite, resolved: false } }),
    ]);

    res.json({
      reviews: {
        total: totalReviews,
        pending: pendingReviews,
        approved: approvedReviews,
        rejected: rejectedReviews,
        flagged: flaggedReviews,
      },
      questions: {
        total: totalQuestions,
        answered: answeredQuestions,
        unanswered: totalQuestions - answeredQuestions,
      },
      moderation: {
        unresolvedReports,
        pendingModeration: pendingReviews + flaggedReviews,
      },
    });
  } catch (error) {
    console.error('Error getting summary:', error);
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

export default router;
