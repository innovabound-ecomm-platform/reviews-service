import { Router, Request, Response } from 'express';
import { getReviewsPrisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  updateAnswerSchema,
  voteSchema,
} from '../schemas/review.schema.js';
import {
  getSiteId,
  requireSiteId,
  answerWhere,
  withSiteId,
} from '../utils/tenant.utils.js';

const router: Router = Router();
const prisma = getReviewsPrisma();

/**
 * @openapi
 * /reviews/answers/{id}:
 *   get:
 *     summary: Get answer by ID
 *     description: Retrieve a single answer with its associated question.
 *     tags:
 *       - Answers
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
 *         description: Answer details
 *       404:
 *         description: Answer not found
 *       500:
 *         description: Server error
 */
// Get answer by ID
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const siteId = getSiteId(req);
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findFirst({
      where: answerWhere(siteId, { id }, { strict: false }),
      include: {
        question: true,
      },
    });

    if (!answer) {
      res.status(404).json({ error: 'Answer not found' });
      return;
    }

    res.json(answer);
  } catch (error) {
    console.error('Error getting answer:', error);
    res.status(500).json({ error: 'Failed to get answer' });
  }
});

/**
 * @openapi
 * /reviews/answers/{id}:
 *   put:
 *     summary: Update answer
 *     description: Update answer content. Only author or admin can update.
 *     tags:
 *       - Answers
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
 *         description: Answer updated
 *       403:
 *         description: Access denied
 *       404:
 *         description: Answer not found
 *       500:
 *         description: Server error
 */
// Update answer
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);
    const data = updateAnswerSchema.parse(req.body);

    const answer = await prisma.answer.findFirst({
      where: answerWhere(siteId, { id }),
    });

    if (!answer) {
      res.status(404).json({ error: 'Answer not found' });
      return;
    }

    // Only author can update
    if (answer.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const updated = await prisma.answer.update({
      where: { id },
      data: {
        ...data,
        updatedBy: req.user!.userId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating answer:', error);
    res.status(500).json({ error: 'Failed to update answer' });
  }
});

/**
 * @openapi
 * /reviews/answers/{id}:
 *   delete:
 *     summary: Delete answer
 *     description: Permanently delete an answer. Author or admin can delete.
 *     tags:
 *       - Answers
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
 *         description: Answer deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Answer not found
 *       500:
 *         description: Server error
 */
// Delete answer
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findFirst({
      where: answerWhere(siteId, { id }),
    });

    if (!answer) {
      res.status(404).json({ error: 'Answer not found' });
      return;
    }

    // Author or admin can delete
    if (answer.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.answer.delete({
      where: { id },
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting answer:', error);
    res.status(500).json({ error: 'Failed to delete answer' });
  }
});

/**
 * @openapi
 * /reviews/answers/{id}/accept:
 *   post:
 *     summary: Accept answer as best answer
 *     description: Mark answer as accepted (best answer). Only question author or admin can accept. Unaccepts previous answer if any.
 *     tags:
 *       - Answers
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
 *         description: Answer accepted
 *       403:
 *         description: Only question author can accept
 *       404:
 *         description: Answer not found
 *       500:
 *         description: Server error
 */
// Accept answer as best answer
router.post('/:id/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findFirst({
      where: answerWhere(siteId, { id }),
      include: { question: true },
    });

    if (!answer) {
      res.status(404).json({ error: 'Answer not found' });
      return;
    }

    // Only question author or admin can accept
    if (answer.question.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Only question author can accept an answer' });
      return;
    }

    // Unaccept any previously accepted answer
    await prisma.answer.updateMany({
      where: answerWhere(siteId, {
        questionId: answer.questionId,
        isAccepted: true,
      }),
      data: { isAccepted: false },
    });

    // Accept this answer
    const updated = await prisma.answer.update({
      where: { id },
      data: {
        isAccepted: true,
        updatedBy: req.user!.userId,
      },
    });

    // Update question status
    await prisma.question.update({
      where: { id: answer.questionId },
      data: { status: 'ANSWERED' },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error accepting answer:', error);
    res.status(500).json({ error: 'Failed to accept answer' });
  }
});

/**
 * @openapi
 * /reviews/answers/{id}/unaccept:
 *   post:
 *     summary: Unaccept answer
 *     description: Remove accepted status from an answer. Only question author or admin can unaccept.
 *     tags:
 *       - Answers
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
 *         description: Answer unaccepted
 *       403:
 *         description: Only question author can unaccept
 *       404:
 *         description: Answer not found
 *       500:
 *         description: Server error
 */
// Unaccept answer
router.post('/:id/unaccept', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findFirst({
      where: answerWhere(siteId, { id }),
      include: { question: true },
    });

    if (!answer) {
      res.status(404).json({ error: 'Answer not found' });
      return;
    }

    // Only question author or admin can unaccept
    if (answer.question.userId !== req.user!.userId && !req.user!.roles.includes('admin')) {
      res.status(403).json({ error: 'Only question author can unaccept an answer' });
      return;
    }

    const updated = await prisma.answer.update({
      where: { id },
      data: {
        isAccepted: false,
        updatedBy: req.user!.userId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error unaccepting answer:', error);
    res.status(500).json({ error: 'Failed to unaccept answer' });
  }
});

/**
 * @openapi
 * /reviews/answers/{id}/vote:
 *   post:
 *     summary: Vote on answer
 *     description: Mark answer as helpful or not helpful. Cannot vote on own answers. Updates vote if already voted.
 *     tags:
 *       - Answer Voting
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
 *         description: Cannot vote on own answer
 *       404:
 *         description: Answer not found
 *       500:
 *         description: Server error
 */
// Vote on answer
router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const answerId = parseInt(req.params.id!);
    const { voteType } = voteSchema.parse(req.body);

    const answer = await prisma.answer.findFirst({
      where: answerWhere(siteId, { id: answerId }),
    });

    if (!answer) {
      res.status(404).json({ error: 'Answer not found' });
      return;
    }

    // Can't vote on own answer
    if (answer.userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot vote on your own answer' });
      return;
    }

    const existingVote = await prisma.answerVote.findUnique({
      where: {
        answerId_userId: {
          answerId,
          userId: req.user!.userId,
        },
      },
    });

    if (existingVote) {
      // Update vote
      await prisma.answerVote.update({
        where: { id: existingVote.id },
        data: { voteType, updatedBy: req.user!.userId },
      });

      // Update count if vote type changed
      if (existingVote.voteType !== voteType) {
        const helpfulDelta = existingVote.voteType === 'HELPFUL' ? -1 : (voteType === 'HELPFUL' ? 1 : 0);

        await prisma.answer.update({
          where: { id: answerId },
          data: {
            helpfulCount: { increment: helpfulDelta },
          },
        });
      }
    } else {
      // Create vote
      await prisma.answerVote.create({
        data: withSiteId({
          answerId,
          userId: req.user!.userId,
          voteType,
          createdBy: req.user!.userId,
          updatedBy: req.user!.userId,
        }, siteId),
      });

      // Update count
      if (voteType === 'HELPFUL') {
        await prisma.answer.update({
          where: { id: answerId },
          data: { helpfulCount: { increment: 1 } },
        });
      }
    }

    res.json({ message: 'Vote recorded' });
  } catch (error) {
    console.error('Error voting:', error);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

/**
 * @openapi
 * /reviews/answers/{id}/vote:
 *   delete:
 *     summary: Remove vote from answer
 *     description: Remove your vote (helpful/not helpful) from an answer.
 *     tags:
 *       - Answer Voting
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
// Remove vote from answer
router.delete('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const siteId = requireSiteId(req);
    const answerId = parseInt(req.params.id!);

    const vote = await prisma.answerVote.findUnique({
      where: {
        answerId_userId: {
          answerId,
          userId: req.user!.userId,
        },
      },
    });

    if (!vote) {
      res.status(404).json({ error: 'Vote not found' });
      return;
    }

    await prisma.answerVote.delete({
      where: { id: vote.id },
    });

    // Update count
    if (vote.voteType === 'HELPFUL') {
      await prisma.answer.update({
        where: { id: answerId },
        data: { helpfulCount: { decrement: 1 } },
      });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error removing vote:', error);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

export default router;
