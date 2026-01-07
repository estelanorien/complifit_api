import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { env } from '../../../config/env';

/**
 * Rate limiting configuration for different endpoint types
 */

// Global rate limit configuration
const globalRateLimitConfig = {
  max: env.nodeEnv === 'production' ? 100 : 1000,
  timeWindow: '1 minute',
  errorResponseBuilder: (req: any, context: any) => {
    return {
      error: 'Too many requests',
      message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow}.`,
      retryAfter: Math.round(context.ttl / 1000),
      requestId: (req as any).requestId || 'unknown',
    };
  },
  skip: (req: any) => {
    // Skip rate limiting for health checks
    return req.url?.startsWith('/api/health');
  },
};

// Auth endpoint rate limit (stricter for security)
const authRateLimitConfig = {
  max: 5, // 5 requests per minute
  timeWindow: '1 minute',
  keyGenerator: (req: any) => {
    // Use IP address for rate limiting
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
  errorResponseBuilder: (req: any, context: any) => {
    return {
      error: 'Too many authentication attempts',
      message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow}. Please try again later.`,
      retryAfter: Math.round(context.ttl / 1000),
      requestId: (req as any).requestId || 'unknown',
    };
  },
  onExceeding: (req: any, key: string) => {
    req.log.warn({
      type: 'rate_limit_exceeding',
      requestId: (req as any).requestId,
      ip: req.ip,
      url: req.url,
      key,
    });
  },
  onExceeded: (req: any, key: string) => {
    req.log.warn({
      type: 'rate_limit_exceeded',
      requestId: (req as any).requestId,
      ip: req.ip,
      url: req.url,
      key,
    });
  },
};

// AI endpoint rate limit (more restrictive due to cost)
const aiRateLimitConfig = {
  max: env.nodeEnv === 'production' ? 20 : 100, // 20 requests per minute in production
  timeWindow: '1 minute',
  keyGenerator: (req: any) => {
    // Use user ID if authenticated, otherwise IP
    const userId = (req as any).user?.userId;
    return userId ? `user:${userId}` : `ip:${req.ip || 'unknown'}`;
  },
  errorResponseBuilder: (req: any, context: any) => {
    return {
      error: 'AI service rate limit exceeded',
      message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow}.`,
      retryAfter: Math.round(context.ttl / 1000),
      requestId: (req as any).requestId || 'unknown',
    };
  },
};

// Admin endpoint rate limit
const adminRateLimitConfig = {
  max: 50, // 50 requests per minute
  timeWindow: '1 minute',
  keyGenerator: (req: any) => {
    // Use user ID for admin endpoints
    const userId = (req as any).user?.userId;
    return userId ? `admin:${userId}` : `ip:${req.ip || 'unknown'}`;
  },
  errorResponseBuilder: (req: any, context: any) => {
    return {
      error: 'Admin rate limit exceeded',
      message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow}.`,
      retryAfter: Math.round(context.ttl / 1000),
      requestId: (req as any).requestId || 'unknown',
    };
  },
};

/**
 * Register global rate limiting
 */
export function registerGlobalRateLimit(app: FastifyInstance) {
  app.register(rateLimit, globalRateLimitConfig);
}

/**
 * Register auth-specific rate limiting
 * Should be registered on auth routes only
 */
export function registerAuthRateLimit(app: FastifyInstance) {
  app.register(rateLimit, authRateLimitConfig);
}

/**
 * Register AI-specific rate limiting
 * Should be registered on AI routes only
 */
export function registerAiRateLimit(app: FastifyInstance) {
  app.register(rateLimit, aiRateLimitConfig);
}

/**
 * Register admin-specific rate limiting
 * Should be registered on admin routes only
 */
export function registerAdminRateLimit(app: FastifyInstance) {
  app.register(rateLimit, adminRateLimitConfig);
}

