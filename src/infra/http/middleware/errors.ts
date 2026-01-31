import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

/**
 * Base application error class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: any;

  constructor(
    statusCode: number,
    message: string,
    isOperational = true,
    details?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: z.ZodError) {
    super(400, message, true, details);
  }
}

/**
 * Authentication error (401)
 */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed') {
    super(401, message);
  }
}

/**
 * Authorization error (403)
 */
export class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(403, message);
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, `${resource} not found`);
  }
}

/**
 * Conflict error (409)
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}

/**
 * Rate limit error (429)
 */
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfter?: number) {
    super(429, message, true, retryAfter ? { retryAfter } : undefined);
  }
}

/**
 * Internal server error (500)
 */
export class InternalServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(500, message, false);
  }
}

/**
 * Service unavailable error (503)
 */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(503, message);
  }
}

/**
 * Central error handler middleware
 */
export async function errorHandler(
  error: Error,
  req: FastifyRequest,
  reply: FastifyReply
) {
  // CORS on every error response - use * so browser never blocks (credentials false)
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Credentials', 'false');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id, x-goog-api-key, x-api-key');

  const requestId = (req as any).requestId || 'unknown';
  const isProduction = process.env.NODE_ENV === 'production';
  const userId = (req as any).user?.userId || null;

  // Log error with structured format
  req.log?.error({
    error: {
      name: error.name,
      message: error.message,
      stack: isProduction ? undefined : error.stack,
    },
    request: {
      id: requestId,
      method: req.method,
      url: req.url,
      ip: req.ip,
    },
    user: userId ? { id: userId } : undefined,
  });

  // Handle known application errors
  if (error instanceof AppError) {
    const response: any = {
      error: error.message,
      requestId,
    };

    if (error.details) {
      response.details = error.details;
    }

    return reply.status(error.statusCode).send(response);
  }

  // Handle Zod validation errors
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      error: 'Validation failed',
      details: error.errors,
      requestId,
    });
  }

  // Handle PostgreSQL errors
  if ((error as any).code) {
    const pgError = error as any;

    // Unique violation
    if (pgError.code === '23505') {
      return reply.status(409).send({
        error: 'Resource already exists',
        requestId,
      });
    }

    // Foreign key violation
    if (pgError.code === '23503') {
      return reply.status(400).send({
        error: 'Referenced resource does not exist',
        requestId,
      });
    }

    // Not null violation
    if (pgError.code === '23502') {
      return reply.status(400).send({
        error: 'Required field is missing',
        requestId,
      });
    }

    // Check constraint violation
    if (pgError.code === '23514') {
      return reply.status(400).send({
        error: 'Data validation failed',
        requestId,
      });
    }
  }

  // Handle Fastify errors
  if ((error as any).statusCode) {
    const fastifyError = error as any;
    return reply.status(fastifyError.statusCode).send({
      error: fastifyError.message || 'Request error',
      requestId,
    });
  }

  // Handle Rate Limit errors that might be missing statusCode
  if (error.message && (error.message.includes('Rate limit') || error.message.includes('Too many requests'))) {
    return reply.status(429).send({
      error: error.message,
      requestId,
      retryAfter: 60
    });
  }

  // Auth/profile paths: never return 500 so clients get retryable 503
  const url = (req as any).url || (req as any).routerPath || '';
  const isAuthOrProfile = typeof url === 'string' && (url.includes('/api/auth') || url.includes('/api/profiles'));
  const status = isAuthOrProfile ? 503 : 500;
  return reply.status(status).send({
    error: isProduction ? (status === 503 ? 'Service temporarily unavailable. Please try again.' : 'An internal server error occurred. Please try again later.') : (error.message || 'Unknown error occurred'),
    requestId,
    ...(isProduction ? {} : {
      stack: error.stack,
      details: error.message
    }),
  });
}

