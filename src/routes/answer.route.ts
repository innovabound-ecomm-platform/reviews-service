import { Router, Request, Response } from 'express';
import { getReviewsPrisma } from '@innovabound-ecomm-platform/reviews-db';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  updateAnswerSchema,
  voteSchema,
} from '../schemas/review.schema.js';

const router = Router();
const prisma = getReviewsPrisma();

// Get answer by ID
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findUnique({
      where: { id },
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

// Update answer
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);
    const data = updateAnswerSchema.parse(req.body);

    const answer = await prisma.answer.findUnique({
      where: { id },
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

// Delete answer
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findUnique({
      where: { id },
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

// Accept answer as best answer
router.post('/:id/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findUnique({
      where: { id },
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
      where: {
        questionId: answer.questionId,
        isAccepted: true,
      },
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

// Unaccept answer
router.post('/:id/unaccept', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id!);

    const answer = await prisma.answer.findUnique({
      where: { id },
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

// Vote on answer
router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
    const answerId = parseInt(req.params.id!);
    const { voteType } = voteSchema.parse(req.body);

    const answer = await prisma.answer.findUnique({
      where: { id: answerId },
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
        data: {
          answerId,
          userId: req.user!.userId,
          voteType,
          createdBy: req.user!.userId,
          updatedBy: req.user!.userId,
        },
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

// Remove vote from answer
router.delete('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  try {
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
