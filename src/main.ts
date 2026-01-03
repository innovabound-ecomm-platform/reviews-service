import { config } from "./config/index.js";
import { logger } from "./config/logger.js";
import { createApp } from "./app.js";

const app = createApp();

const server = app.listen(parseInt(config.PORT), () => {
  logger.info(`Reviews service started`, {
    port: config.PORT,
    environment: config.NODE_ENV,
  });
  logger.info("API Documentation available", {
    swaggerUI: `http://localhost:${config.PORT}/api-docs`,
    openApiJson: `http://localhost:${config.PORT}/api-docs.json`,
    reDoc: `http://localhost:${config.PORT}/redoc`,
  });
});

// Graceful shutdown handlers
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  server.close((err) => {
    if (err) {
      logger.error("Error during server close", err);
      process.exit(1);
    }
    
    logger.info("Server closed successfully");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.warn("Forcing shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
