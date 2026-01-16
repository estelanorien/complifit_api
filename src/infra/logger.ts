import { env } from '../config/env.js';

/**
 * Standalone logger for services that don't have request context
 * Outputs structured JSON logs compatible with Fastify's Pino logger
 */
class Logger {
  private isDevelopment = env.nodeEnv === 'development';

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, context?: Record<string, any>) {
    const logEntry = {
      level: this.getLevelNumber(level),
      time: Date.now(),
      msg: message,
      ...context,
      env: env.nodeEnv
    };

    const output = JSON.stringify(logEntry) + '\n';

    if (level === 'error') {
      process.stderr.write(output);
    } else {
      process.stdout.write(output);
    }
  }

  private getLevelNumber(level: string): number {
    switch (level) {
      case 'error': return 50;
      case 'warn': return 40;
      case 'info': return 30;
      case 'debug': return 20;
      default: return 30;
    }
  }

  info(message: string, context?: Record<string, any>) {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>) {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error | any, context?: Record<string, any>) {
    const errorContext = {
      ...context,
      error: error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: this.isDevelopment ? error.stack : undefined
          }
        : error
    };
    this.log('error', message, errorContext);
  }

  debug(message: string, context?: Record<string, any>) {
    if (this.isDevelopment) {
      this.log('debug', message, context);
    }
  }
}

export const logger = new Logger();
