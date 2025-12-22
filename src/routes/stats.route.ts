import { Router, Request, Response } from 'express';
import { prisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, requirePermission, optionalAuth } from '../middleware/auth';

const router = Router();

// Get product review stats
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    const stats = await prisma.productReviewStats.findUnique({
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

// Recalculate product stats (admin)
router.post('/product/:productId/recalculate', requireAuth, requirePermission('admin'), async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    // Calculate review stats
    const reviewStats = await prisma.review.groupBy({
      by: ['rating'],
      where: { productId, status: 'APPROVED' },
      _count: true,
    });

    const verifiedStats = await prisma.review.aggregate({
      where: { productId, status: 'APPROVED', verifiedPurchase: true },
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
      prisma.question.count({ where: { productId } }),
      prisma.question.count({ where: { productId, status: 'ANSWERED' } }),
    ]);

    // Upsert stats
    const stats = await prisma.productReviewStats.upsert({
      where: { productId },
      create: {
        productId,
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

// Get stats for multiple products
router.post('/products', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { productIds } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      res.status(400).json({ error: 'Product IDs array is required' });
      return;
    }

    if (productIds.length > 100) {
      res.status(400).json({ error: 'Maximum 100 products per request' });
      return;
    }

    const stats = await prisma.productReviewStats.findMany({
      where: { productId: { in: productIds } },
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

// Get top rated products
router.get('/top-rated', optionalAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const minReviews = parseInt(req.query.minReviews as string) || 5;

    const stats = await prisma.productReviewStats.findMany({
      where: {
        reviewCount: { gte: minReviews },
      },
      orderBy: { averageRating: 'desc' },
      take: limit,
    });

    res.json(stats);
  } catch (error) {
    console.error('Error getting top rated:', error);
    res.status(500).json({ error: 'Failed to get top rated products' });
  }
});

// Get review statistics summary (admin)
router.get('/summary', requireAuth, requirePermission('admin'), async (req: Request, res: Response) => {
  try {
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
      prisma.review.count(),
      prisma.review.count({ where: { status: 'PENDING' } }),
      prisma.review.count({ where: { status: 'APPROVED' } }),
      prisma.review.count({ where: { status: 'REJECTED' } }),
      prisma.review.count({ where: { status: 'FLAGGED' } }),
      prisma.question.count(),
      prisma.question.count({ where: { status: 'ANSWERED' } }),
      prisma.reviewReport.count({ where: { resolved: false } }),
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
