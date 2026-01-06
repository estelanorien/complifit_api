import { FastifyRequest, FastifyReply } from 'fastify';

// Store request start times
const requestTimers = new Map<string, number>();

/**
 * Enhanced request logger with request ID support
 * Uses Fastify's built-in logger (Pino) for structured logging
 */
export async function requestLogger(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = (req as any).requestId || 'unknown';
  const startTime = Date.now();
  requestTimers.set(requestId, startTime);
  
  // Log request start with structured format
  req.log.info({
    type: 'request_start',
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
}

/**
 * Enhanced response logger with request ID and structured logging
 */
export async function responseLogger(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = (req as any).requestId || 'unknown';
  const startTime = requestTimers.get(requestId) || Date.now();
  const responseTime = Date.now() - startTime;
  requestTimers.delete(requestId);

  const userId = (req as any).user?.userId || null;
  const statusCode = reply.statusCode;

  // Log response with structured format
  const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  
  req.log[logLevel]({
    type: 'request_complete',
    requestId,
    method: req.method,
    url: req.url,
    statusCode,
    responseTime: `${responseTime}ms`,
    responseTimeMs: responseTime,
    userId: userId || undefined,
    ip: req.ip,
  });
}

/**
 * Enhanced error logger with request ID and structured logging
 * Note: This is a fallback - most errors are handled by the central error handler
 */
export async function errorLogger(
  req: FastifyRequest,
  reply: FastifyReply,
  error: Error
) {
  const requestId = (req as any).requestId || 'unknown';
  const startTime = requestTimers.get(requestId) || Date.now();
  const responseTime = Date.now() - startTime;
  requestTimers.delete(requestId);

  const userId = (req as any).user?.userId || null;

  // Log error with structured format
  req.log.error({
    type: 'request_error',
    requestId,
    method: req.method,
    url: req.url,
    statusCode: reply.statusCode || 500,
    responseTime: `${responseTime}ms`,
    responseTimeMs: responseTime,
    userId: userId || undefined,
    error: {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
    },
    ip: req.ip,
  });
}

