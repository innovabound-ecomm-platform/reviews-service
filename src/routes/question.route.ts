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
import {
  getSiteId,
  requireSiteId,
  questionWhere,
  answerWhere,
  withSiteId,
} from '../utils/tenant.utils.js';

const router: Router = Router();
const prisma = getReviewsPrisma();

// Helper to update product Q&A stats
async function updateProductQAStats(productId: string, siteId: string) {
  const [questionCount, answeredCount] = await Promise.all([
    prisma.question.count({ where: questionWhere(siteId, { productId }) }),
    prisma.question.count({ where: questionWhere(siteId, { productId, status: 'ANSWERED' }) }),
  ]);

  await prisma.productReviewStats.upsert({
    where: { siteId_productId: { siteId, productId } },
    create: {
      productId,
      siteId,
      questionCount,
      answeredCount,
    },
    update: {
      questionCount,
      answeredCount,
    },
  });
}

/**
 * @openapi
 * /reviews/questions:
 *   post:
 *     summary: Create a question
 *     description: Submit a product question. Updates product Q&A stats.
 *     tags:
 *       - Questions
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId, body]
 *             properties:
 *               productId:
 *                 type: string
 *               displayName:
 *                 type: string
 *               body:
 *                 type: string
 *     responses:
 *       201:
 *         description: Question created
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Server error
 */
// Create question
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const data = createQuestionSchema.parse(req.body);

    const question = await prisma.question.create({
      data: withSiteId({
        productId: data.productId,
        userId: req.user!.userId,
        displayName: data.displayName,
        body: data.body,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      }, siteId),
    });

    // Update stats
    await updateProductQAStats(data.productId, siteId);

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

/**
 * @openapi
 * /reviews/questions:
 *   get:
 *     summary: List questions
 *     description: Get paginated list of questions with filtering and sorting.
 *     tags:
 *       - Questions
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
 *           enum: [OPEN, ANSWERED, CLOSED]
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [newest, oldest, popular]
 *     responses:
 *       200:
 *         description: Paginated list of questions
 *       500:
 *         description: Server error
 */
// List questions
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const query = questionQuerySchema.parse(req.query);
    const { page, limit, status, sortBy } = query;

    const additionalWhere: Record<string, unknown> = {};
    if (status) additionalWhere.status = status;

    const where = questionWhere(siteId, additionalWhere, { strict: false });

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

/**
 * @openapi
 * /reviews/questions/{id}:
 *   get:
 *     summary: Get question by ID
 *     description: Retrieve a single question with all answers sorted by acceptance, vendor status, and helpfulness.
 *     tags:
 *       - Questions
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
 *         description: Question details with answers
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
// Get question by ID
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const id = parseInt(req.params.id!);

    const question = await prisma.question.findFirst({
      where: questionWhere(siteId, { id }, { strict: false }),
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

/**
 * @openapi
 * /reviews/questions/product/{productId}:
 *   get:
 *     summary: Get questions for a product
 *     description: Retrieve paginated questions for a specific product with accepted answers.
 *     tags:
 *       - Questions
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
 *         name: status
 *         schema:
 *           type: string
 *           enum: [OPEN, ANSWERED, CLOSED]
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [newest, oldest, popular]
 *     responses:
 *       200:
 *         description: Product questions
 *       500:
 *         description: Server error
 */
// Get questions for a product
router.get('/product/:productId', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const { productId } = req.params;
    const query = questionQuerySchema.parse(req.query);
    const { page, limit, status, sortBy } = query;

    const additionalWhere: Record<string, unknown> = { productId };
    if (status) additionalWhere.status = status;

    const where = questionWhere(siteId, additionalWhere, { strict: false });

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

/**
 * @openapi
 * /reviews/questions/{id}:
 *   put:
 *     summary: Update question
 *     description: Update question content. Only author or admin can update.
 *     tags:
 *       - Questions
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
 *               displayName:
 *                 type: string
 *               body:
 *                 type: string
 *     responses:
 *       200:
 *         description: Question updated
 *       403:
 *         description: Access denied
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
// Update question
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const data = updateQuestionSchema.parse(req.body);

    const question = await prisma.question.findFirst({
      where: questionWhere(siteId, { id }),
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

/**
 * @openapi
 * /reviews/questions/{id}:
 *   delete:
 *     summary: Delete question
 *     description: Permanently delete a question and all its answers. Author or admin can delete. Updates product stats.
 *     tags:
 *       - Questions
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
 *         description: Question deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
// Delete question
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);

    const question = await prisma.question.findFirst({
      where: questionWhere(siteId, { id }),
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
    await updateProductQAStats(question.productId, siteId);

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting question:', error);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

/**
 * @openapi
 * /reviews/questions/{id}/close:
 *   post:
 *     summary: Close question
 *     description: Close a question to prevent new answers. Author or admin can close.
 *     tags:
 *       - Questions
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
 *         description: Question closed
 *       403:
 *         description: Access denied
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
// Close question
router.post('/:id/close', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);

    const question = await prisma.question.findFirst({
      where: questionWhere(siteId, { id }),
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

/**
 * @openapi
 * /reviews/questions/{id}/vote:
 *   post:
 *     summary: Vote on question
 *     description: Upvote a question to show interest. Cannot vote on own questions. One vote per user.
 *     tags:
 *       - Question Voting
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
 *         description: Vote recorded
 *       400:
 *         description: Cannot vote on own question or already voted
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
// Vote on question
router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const questionId = parseInt(req.params.id!);

    const question = await prisma.question.findFirst({
      where: questionWhere(siteId, { id: questionId }),
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
      data: withSiteId({
        questionId,
        userId: req.user!.userId,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      }, siteId),
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

/**
 * @openapi
 * /reviews/questions/{id}/vote:
 *   delete:
 *     summary: Remove vote from question
 *     description: Remove your upvote from a question.
 *     tags:
 *       - Question Voting
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
// Remove vote from question
router.delete('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
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

/**
 * @openapi
 * /reviews/questions/{questionId}/answers:
 *   post:
 *     summary: Add answer to question
 *     description: Submit an answer to a question. Vendors/admins can mark as vendor answer. Updates question status.
 *     tags:
 *       - Answers
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: questionId
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
 *               displayName:
 *                 type: string
 *               body:
 *                 type: string
 *               isVendor:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Answer created
 *       400:
 *         description: Question is closed
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
// Add answer
router.post('/:questionId/answers', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const questionId = parseInt(req.params.questionId!);
    const data = createAnswerSchema.parse(req.body);

    const question = await prisma.question.findFirst({
      where: questionWhere(siteId, { id: questionId }),
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
      data: withSiteId({
        questionId,
        userId: req.user!.userId,
        displayName: data.displayName,
        body: data.body,
        isVendor,
        createdBy: req.user!.userId,
        updatedBy: req.user!.userId,
      }, siteId),
    });

    // Update question status if first answer
    if (question.status === 'OPEN') {
      await prisma.question.update({
        where: { id: questionId },
        data: { status: 'ANSWERED' },
      });

      // Update product stats
      await updateProductQAStats(question.productId, siteId);
    }

    res.status(201).json(answer);
  } catch (error) {
    console.error('Error creating answer:', error);
    res.status(500).json({ error: 'Failed to create answer' });
  }
});

/**
 * @openapi
 * /reviews/questions/{questionId}/answers:
 *   get:
 *     summary: List answers for question
 *     description: Get all answers for a question sorted by acceptance, vendor status, and helpfulness.
 *     tags:
 *       - Answers
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: questionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of answers
 *       500:
 *         description: Server error
 */
// List answers for question
router.get('/:questionId/answers', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const questionId = parseInt(req.params.questionId!);

    const answers = await prisma.answer.findMany({
      where: answerWhere(siteId, { questionId }, { strict: false }),
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
