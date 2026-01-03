import { Router, Request, Response } from 'express';
import { getReviewsPrisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  createQuestionSchema,
  updateQuestionSchema,
  questionQuerySchema,
  createAnswerSchema,
  updateAnswerSchema,
  voteSchema,
} from '../schemas/review.schema.js';

const router: Router = Router();
const prisma = getReviewsPrisma();

// Helper to update product Q&A stats
async function updateProductQAStats(productId: string) {
  const [questionCount, answeredCount] = await Promise.all([
    prisma.question.count({ where: { productId } }),
    prisma.question.count({ where: { productId, status: 'ANSWERED' } }),
  ]);

  await prisma.productReviewStats.upsert({
    where: { productId },
    create: {
      productId,
      questionCount,
      answeredCount,
    },
    update: {
      questionCount,
      answeredCount,
    },
  });
}

// Create question
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = createQuestionSchema.parse(req.body);

    const question = await prisma.question.create({
      data: {
        productId: data.productId,
        userId: req.user!.userId,
        displayName: data.displayName,
        body: data.body,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
    });

    // Update stats
    await updateProductQAStats(data.productId);

    res.status(201).json(question);
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      res.status(400).json({ error: 'Validation error', details: error });
      return;
    }
    console.error('Error creating question:', error);
    res.status(500).json({ error: 'Failed to create question' });
  }
});

// List questions
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const query = questionQuerySchema.parse(req.query);
    const { page, limit, status, sortBy } = query;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const orderBy: Record<string, string> = {};
    switch (sortBy) {
      case 'newest': orderBy.createdAt = 'desc'; break;
      case 'oldest': orderBy.createdAt = 'asc'; break;
      case 'popular': orderBy.voteCount = 'desc'; break;
    }

    const [questions, total] = await Promise.all([
      prisma.question.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          _count: {
            select: { answers: true, votes: true },
          },
        },
      }),
      prisma.question.count({ where }),
    ]);

    res.json({
      data: questions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error listing questions:', error);
    res.status(500).json({ error: 'Failed to list questions' });
  }
});

// Get question by ID
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const question = await prisma.question.findUnique({
      where: { id },
      include: {
        answers: {
          orderBy: [
            { isAccepted: 'desc' },
            { isVendor: 'desc' },
            { helpfulCount: 'desc' },
          ],
        },
        _count: {
          select: { answers: true, votes: true },
        },
      },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    res.json(question);
  } catch (error) {
    console.error('Error getting question:', error);
    res.status(500).json({ error: 'Failed to get question' });
  }
});

// Get questions for a product
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const query = questionQuerySchema.parse(req.query);
    const { page, limit, status, sortBy } = query;

    const where: Record<string, unknown> = { productId };
    if (status) where.status = status;

    const orderBy: Record<string, string> = {};
    switch (sortBy) {
      case 'newest': orderBy.createdAt = 'desc'; break;
      case 'oldest': orderBy.createdAt = 'asc'; break;
      case 'popular': orderBy.voteCount = 'desc'; break;
    }

    const [questions, total] = await Promise.all([
      prisma.question.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          answers: {
            where: { isAccepted: true },
            take: 1,
          },
          _count: {
            select: { answers: true },
          },
        },
      }),
      prisma.question.count({ where }),
    ]);

    res.json({
      data: questions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error getting product questions:', error);
    res.status(500).json({ error: 'Failed to get product questions' });
  }
});

// Update question
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);
    const data = updateQuestionSchema.parse(req.body);

    const question = await prisma.question.findUnique({
      where: { id },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    // Only author can update
    if (question.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updated = await prisma.question.update({
      where: { id },
      data: {
        ...data,
        updatedBy: req.user!.userId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating question:', error);
    res.status(500).json({ error: 'Failed to update question' });
  }
});

// Delete question
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const question = await prisma.question.findUnique({
      where: { id },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    // Author or admin can delete
    if (question.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.question.delete({
      where: { id },
    });

    // Update stats
    await updateProductQAStats(question.productId);

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting question:', error);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// Close question
router.post('/:id/close', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const question = await prisma.question.findUnique({
      where: { id },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    // Author or admin can close
    if (question.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updated = await prisma.question.update({
      where: { id },
      data: {
        status: 'CLOSED',
        updatedBy: req.user!.userId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error closing question:', error);
    res.status(500).json({ error: 'Failed to close question' });
  }
});

// Vote on question
router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const questionId = parseInt(req.params.id!);

    const question = await prisma.question.findUnique({
      where: { id: questionId },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    // Can't vote on own question
    if (question.userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot vote on your own question' });
      return;
    }

    const existingVote = await prisma.questionVote.findUnique({
      where: {
        questionId_userId: {
          questionId,
          userId: req.user!.userId,
        },
      },
    });

    if (existingVote) {
      res.status(400).json({ error: 'Already voted on this question' });
      return;
    }

    await prisma.questionVote.create({
      data: {
        questionId,
        userId: req.user!.userId,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
    });

    await prisma.question.update({
      where: { id: questionId },
      data: { voteCount: { increment: 1 } },
    });

    res.json({ message: 'Vote recorded' });
  } catch (error) {
    console.error('Error voting:', error);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// Remove vote from question
router.delete('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const questionId = parseInt(req.params.id!);

    const vote = await prisma.questionVote.findUnique({
      where: {
        questionId_userId: {
          questionId,
          userId: req.user!.userId,
        },
      },
    });

    if (!vote) {
      res.status(404).json({ error: 'Vote not found' });
      return;
    }

    await prisma.questionVote.delete({
      where: { id: vote.id },
    });

    await prisma.question.update({
      where: { id: questionId },
      data: { voteCount: { decrement: 1 } },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error removing vote:', error);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

// =====================
// ANSWERS
// =====================

// Add answer
router.post('/:questionId/answers', requireAuth, async (req: Request, res: Response) => {
  try {
    const questionId = parseInt(req.params.questionId!);
    const data = createAnswerSchema.parse(req.body);

    const question = await prisma.question.findUnique({
      where: { id: questionId },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    if (question.status === 'CLOSED') {
      res.status(400).json({ error: 'Question is closed' });
      return;
    }

    // Only vendors/admins can mark as vendor answer
    const isVendor = data.isVendor && 
      (req.user!.roles.includes('vendor') || req.user!.roles.includes('admin'));

    const answer = await prisma.answer.create({
      data: {
        questionId,
        userId: req.user!.userId,
        displayName: data.displayName,
        body: data.body,
        isVendor,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      },
    });

    // Update question status if first answer
    if (question.status === 'OPEN') {
      await prisma.question.update({
        where: { id: questionId },
        data: { status: 'ANSWERED' },
      });

      // Update product stats
      await updateProductQAStats(question.productId);
    }

    res.status(201).json(answer);
  } catch (error) {
    console.error('Error creating answer:', error);
    res.status(500).json({ error: 'Failed to create answer' });
  }
});

// List answers for question
router.get('/:questionId/answers', optionalAuth, async (req: Request, res: Response) => {
  try {
    const questionId = parseInt(req.params.questionId!);

    const answers = await prisma.answer.findMany({
      where: { questionId },
      orderBy: [
        { isAccepted: 'desc' },
        { isVendor: 'desc' },
        { helpfulCount: 'desc' },
        { createdAt: 'asc' },
      ],
    });

    res.json(answers);
  } catch (error) {
    console.error('Error listing answers:', error);
    res.status(500).json({ error: 'Failed to list answers' });
  }
});

export default router;
