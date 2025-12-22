import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import reviewRoutes from './routes/review.route';
import moderationRoutes from './routes/moderation.route';
import questionRoutes from './routes/question.route';
import answerRoutes from './routes/answer.route';
import statsRoutes from './routes/stats.route';

const app = express();
const PORT = process.env.PORT || 3013;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'reviews-service' });
});

// Routes
app.use('/reviews', reviewRoutes);
app.use('/moderation', moderationRoutes);
app.use('/questions', questionRoutes);
app.use('/answers', answerRoutes);
app.use('/stats', statsRoutes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Reviews service running on port ${PORT}`);
});

export default app;
