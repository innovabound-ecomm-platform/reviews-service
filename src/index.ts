import express, { Application } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

import reviewRoutes from './routes/review.route.js';
import moderationRoutes from './routes/moderation.route.js';
import questionRoutes from './routes/question.route.js';
import answerRoutes from './routes/answer.route.js';
import statsRoutes from './routes/stats.route.js';

const app: Application = express();
const PORT = process.env.PORT || 3009;

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3002", "http://localhost:3003", "http://localhost:3100"],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Swagger/OpenAPI configuration
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Reviews Service API',
      version: '1.0.0',
      description: 'API documentation for the Reviews Service. Handles product reviews, ratings, review moderation, Q&A, and review analytics.',
      contact: {
        name: 'InnovaBound E-Commerce Platform',
      },
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
        description: 'Development server',
      },
    ],
    tags: [
      {
        name: 'Reviews',
        description: 'Product review operations',
      },
      {
        name: 'Moderation',
        description: 'Review moderation operations',
      },
      {
        name: 'Questions',
        description: 'Product Q&A questions',
      },
      {
        name: 'Answers',
        description: 'Product Q&A answers',
      },
      {
        name: 'Stats',
        description: 'Review analytics and statistics',
      },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'access_token',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Reviews Service API Docs',
}));

// JSON spec endpoint
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// ReDoc
app.get('/redoc', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Reviews Service API - ReDoc</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
        <style>body { margin: 0; padding: 0; }</style>
      </head>
      <body>
        <redoc spec-url='/api-docs.json'></redoc>
        <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
      </body>
    </html>
  `);
});

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
  console.log(`API Documentation:`);
  console.log(`  - Swagger UI: http://localhost:${PORT}/api-docs`);
  console.log(`  - OpenAPI JSON: http://localhost:${PORT}/api-docs.json`);
  console.log(`  - ReDoc: http://localhost:${PORT}/redoc`);
});

export default app;
