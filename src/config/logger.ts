import { isDevelopment } from "./index.js";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

class Logger {
  private serviceName = "reviews-service";

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      service: this.serviceName,
      message,
      ...context,
    };
    
    return isDevelopment
      ? `[${timestamp}] ${level.toUpperCase()}: ${message} ${context ? JSON.stringify(context) : ""}`
      : JSON.stringify(logEntry);
  }

  debug(message: string, context?: LogContext): void {
    if (isDevelopment) {
      console.debug(this.formatMessage("debug", message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    console.info(this.formatMessage("info", message, context));
  }

  warn(message: string, context?: LogContext): void {
    console.warn(this.formatMessage("warn", message, context));
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const errorContext = error instanceof Error
      ? { error: error.message, stack: error.stack, ...context }
      : { error, ...context };
    
    console.error(this.formatMessage("error", message, errorContext));
  }
}

export const logger = new Logger();
