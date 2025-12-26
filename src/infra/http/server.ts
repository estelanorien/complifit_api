import Fastify from 'fastify';
import { healthRoutes } from './routes/health';
import { aiRoutes } from './routes/ai';
import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profiles';
import { socialRoutes } from './routes/social';
import { restaurantRoutes } from './routes/restaurants';
import { logsRoutes } from './routes/logs';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { challengesRoutes } from './routes/challenges';
import { messagesRoutes } from './routes/messages';
import { moderationRoutes } from './routes/moderation';
import { assetsRoutes } from './routes/assets';
import { usersRoutes } from './routes/users';
import { plansRoutes } from './routes/plans';
import { guardianRoutes } from './routes/guardian';
import { adminRoutes } from './routes/admin';
import { calorieBankRoutes } from './routes/calorieBank';
import { trainingRoutes } from './routes/training';
import { nutritionRoutes } from './routes/nutrition';
import { rehabRoutes } from './routes/rehab';
import { coachRoutes } from './routes/coach';
import { behaviorRoutes } from './routes/behavior';
import { inventoryRoutes } from './routes/inventory';
import { timelineRoutes } from './routes/timeline';
import { negotiationRoutes } from './routes/negotiations';
import { lookupRoutes } from './routes/lookups';
import { locationRoutes } from './routes/location';
import { requestLogger, responseLogger, errorLogger } from './hooks/requestLogger';

import { env } from '../../config/env';

export function buildServer() {
  const app = Fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 30000 // 30 second timeout
  });

  // CORS configuration - production-safe
  const corsOptions = env.nodeEnv === 'production' && env.allowedOrigins
    ? {
        origin: env.allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true
      }
    : {
        origin: true, // Allow all in development
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true
      };

  // Security headers
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://generativelanguage.googleapis.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow external resources if needed
  });

  app.register(cors, corsOptions);

  // Rate limiting - protect against abuse
  app.register(rateLimit, {
    max: env.nodeEnv === 'production' ? 100 : 1000, // requests per timeWindow
    timeWindow: '1 minute',
    errorResponseBuilder: (req, context) => {
      return {
        error: 'Too many requests',
        message: `Rate limit exceeded. Max ${context.max} requests per ${context.timeWindow}.`,
        retryAfter: Math.round(context.ttl / 1000),
      };
    },
    // Skip rate limiting for health checks
    skip: (req) => req.url?.startsWith('/api/health'),
  });

  // Register request logger hooks
  app.addHook('onRequest', requestLogger);
  app.addHook('onResponse', responseLogger);
  app.addHook('onError', errorLogger);

  // Register routes
  app.register(healthRoutes, { prefix: '/api' });
  app.register(authRoutes, { prefix: '/api' });
  app.register(profileRoutes, { prefix: '/api' });
  app.register(socialRoutes, { prefix: '/api' });
  app.register(restaurantRoutes, { prefix: '/api' });
  app.register(logsRoutes, { prefix: '/api' });
  app.register(challengesRoutes, { prefix: '/api' });
  app.register(messagesRoutes, { prefix: '/api' });
  app.register(moderationRoutes, { prefix: '/api' });
  app.register(assetsRoutes, { prefix: '/api' });
  app.register(usersRoutes, { prefix: '/api' });
  app.register(plansRoutes, { prefix: '/api' });
  app.register(trainingRoutes, { prefix: '/api' });
  app.register(nutritionRoutes, { prefix: '/api' });
  app.register(rehabRoutes, { prefix: '/api' });
  app.register(guardianRoutes, { prefix: '/api' });
  app.register(calorieBankRoutes, { prefix: '/api' });
  app.register(coachRoutes, { prefix: '/api' });
  app.register(behaviorRoutes, { prefix: '/api' });
  app.register(inventoryRoutes, { prefix: '/api' });
  app.register(timelineRoutes, { prefix: '/api' });
  app.register(negotiationRoutes, { prefix: '/api' });
  app.register(lookupRoutes, { prefix: '/api' });
  app.register(locationRoutes, { prefix: '/api' });
  app.register(aiRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/api' });

  return app;
}

