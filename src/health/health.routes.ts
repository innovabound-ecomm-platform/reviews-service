import { Router, Request, Response } from "express";
import type { Router as RouterType } from "express";
import { getReviewsPrisma } from "@innovabound-ecomm-platform/reviews-db";

export const healthRoutes: RouterType = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Basic health check (liveness)
 *     description: Returns service status for liveness probes
 *     responses:
 *       200:
 *         description: Service is alive
 */
healthRoutes.get("/", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "reviews-service",
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness check with database
 *     description: Verifies service can handle requests (database connected)
 *     responses:
 *       200:
 *         description: Service is ready
 *       503:
 *         description: Service is not ready
 */
healthRoutes.get("/ready", async (req: Request, res: Response) => {
  try {
    // Check database connection
    const prisma = getReviewsPrisma();
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      status: "ready",
      service: "reviews-service",
      timestamp: new Date().toISOString(),
      checks: {
        database: "ok",
      },
    });
  } catch (error) {
    res.status(503).json({
      status: "not_ready",
      service: "reviews-service",
      timestamp: new Date().toISOString(),
      checks: {
        database: "error",
      },
    });
  }
});
