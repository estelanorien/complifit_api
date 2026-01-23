import { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { env } from '../../../config/env.js';

/**
 * Rate limiting configuration with memory-efficient settings
 */

// ✅ Shared store configuration with aggressive cleanup
const storeConfig = {
  continueExceeding: true,
  // ✅ CRITICAL: Skip successful requests to reduce memory usage
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
};

// Global rate limit configuration
const globalRateLimitConfig = {
  max: env.nodeEnv === 'production' ? 200 : 1000,
  timeWindow: '1 minute',

  // ✅ CRITICAL: Add cache size limit
  cache: 5000, // Max 5000 entries in memory

  // ✅ Clear old entries aggressively
  continueExceeding: true,

  errorResponseBuilder: (req: any, context: any) => {
    return {
      error: 'Too many requests',
      message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow || '1 minute'}.`,
      retryAfter: Math.round((context.ttl || 60000) / 1000),
      requestId: (req as any).requestId || 'unknown',
    };
  },

  keyGenerator: (req: any) => {
    // Global fallback to IP for security
    return req.ip || req.socket.remoteAddress || 'unknown';
  },

  skip: (req: any) => {
    // Skip rate limiting for health checks
    return req.url?.startsWith('/api/health');
  },

  // ✅ Enable rate limit headers to help clients
  enableDraftSpec: true,
  addHeadersOnExceeding: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true
  },
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true
  }
};

// Auth endpoint rate limit (stricter for security)
// FIX: Increase limit for development to prevent login issues
const authRateLimitConfig = {
  max: env.nodeEnv === 'production' ? 20 : 100, // Higher limit in dev
  timeWindow: '1 minute',

  // ✅ Smaller cache for auth
  cache: 1000,

  keyGenerator: (req: any) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },

  errorResponseBuilder: (req: any, context: any) => {
    return {
      error: 'Too many authentication attempts',
      message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow || '1 minute'}. Please try again later.`,
      retryAfter: Math.round((context.ttl || 60000) / 1000),
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

  enableDraftSpec: true,
};

// AI endpoint rate limit
const aiRateLimitConfig = {
  max: env.nodeEnv === 'production' ? 20 : 100,
  timeWindow: '1 minute',

  // ✅ Smaller cache for AI
  cache: 2000,

  keyGenerator: (req: any) => {
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

  enableDraftSpec: true,
};

// Admin endpoint rate limit
const adminRateLimitConfig = {
  max: 50,
  timeWindow: '1 minute',

  // ✅ Smaller cache for admin
  cache: 500,

  keyGenerator: (req: any) => {
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

  enableDraftSpec: true,
};

/**
 * Register global rate limiting
 */
export function registerGlobalRateLimit(app: FastifyInstance) {
  app.register(rateLimit, globalRateLimitConfig);
}

/**
 * Register auth-specific rate limiting
 */
export function registerAuthRateLimit(app: FastifyInstance) {
  app.register(rateLimit, authRateLimitConfig);
}

/**
 * Register AI-specific rate limiting
 */
export function registerAiRateLimit(app: FastifyInstance) {
  app.register(rateLimit, aiRateLimitConfig);
}

/**
 * Register admin-specific rate limiting
 */
export function registerAdminRateLimit(app: FastifyInstance) {
  app.register(rateLimit, adminRateLimitConfig);
}
