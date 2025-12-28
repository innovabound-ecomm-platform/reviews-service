import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import reviewRoutes from './routes/review.route.js';
import moderationRoutes from './routes/moderation.route.js';
import questionRoutes from './routes/question.route.js';
import answerRoutes from './routes/answer.route.js';
import statsRoutes from './routes/stats.route.js';

const app = express();
const PORT = process.env.PORT || 3009;

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3002", "http://localhost:3003", "http://localhost:3100"],
  credentials: true,
}));
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
