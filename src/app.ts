import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

import { config } from "./config/index.js";
import { logger } from "./config/logger.js";
import { AppError } from "./common/errors/AppError.js";

import reviewRoutes from "./routes/review.route.js";
import moderationRoutes from "./routes/moderation.route.js";
import questionRoutes from "./routes/question.route.js";
import answerRoutes from "./routes/answer.route.js";
import statsRoutes from "./routes/stats.route.js";
import { healthRoutes } from "./health/health.routes.js";

export function createApp(): Application {
  const app: Application = express();

  // Middleware
  app.use(cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3002",
      "http://localhost:3003",
      "http://localhost:3100",
    ],
    credentials: true,
  }));
  app.use(express.json());
  app.use(cookieParser());

  // Swagger/OpenAPI configuration
  const swaggerOptions: swaggerJsdoc.Options = {
    definition: {
      openapi: "3.0.3",
      info: {
        title: "Reviews Service API",
        version: "1.0.0",
        description: "API documentation for the Reviews Service. Handles product reviews, ratings, review moderation, Q&A, and review analytics.",
        contact: {
          name: "InnovaBound E-Commerce Platform",
        },
      },
      servers: [
        {
          url: `http://localhost:${config.PORT}`,
          description: "Development server",
        },
      ],
      tags: [
        { name: "Reviews", description: "Product review operations" },
        { name: "Moderation", description: "Review moderation operations" },
        { name: "Questions", description: "Product Q&A questions" },
        { name: "Answers", description: "Product Q&A answers" },
        { name: "Stats", description: "Review analytics and statistics" },
        { name: "Health", description: "Service health endpoints" },
      ],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "access_token",
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    apis: ["./src/routes/*.ts", "./src/routes/*.js"],
  };

  const swaggerSpec = swaggerJsdoc(swaggerOptions);

  // Swagger UI
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "Reviews Service API Docs",
  }));

  // JSON spec endpoint
  app.get("/api-docs.json", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.send(swaggerSpec);
  });

  // ReDoc
  app.get("/redoc", (req: Request, res: Response) => {
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

  // Health endpoints
  app.use("/health", healthRoutes);

  // API Routes
  app.use("/reviews", reviewRoutes);
  app.use("/moderation", moderationRoutes);
  app.use("/questions", questionRoutes);
  app.use("/answers", answerRoutes);
  app.use("/stats", statsRoutes);

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: `Route ${req.method} ${req.path} not found`,
      },
    });
  });

  // Global error handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Handle known AppError instances
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      });
    }

    // Handle standard Error instances
    if (err instanceof Error) {
      logger.error("Unhandled error", err, {
        path: req.path,
        method: req.method,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: config.NODE_ENV === "development" ? err.message : "Internal server error",
        },
      });
    }

    // Unknown error type
    logger.error("Unknown error type", new Error(String(err)));
    return res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    });
  });

  return app;
}
