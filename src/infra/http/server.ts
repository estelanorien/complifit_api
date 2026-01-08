import Fastify from 'fastify';
import { healthRoutes } from './routes/health';
import { aiRoutes } from './routes/ai';
import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profiles';
import { socialRoutes } from './routes/social';
import { restaurantRoutes } from './routes/restaurants';
import { logsRoutes } from './routes/logs';
import cors from '@fastify/cors';
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
import { gamificationRoutes } from './routes/gamification';
import { notificationRoutes } from './routes/notifications';
import { requestLogger, responseLogger, errorLogger } from './hooks/requestLogger';
import { requestIdMiddleware } from './middleware/requestId';
import { errorHandler } from './middleware/errors';
import {
  registerGlobalRateLimit,
  registerAuthRateLimit,
  registerAiRateLimit,
  registerAdminRateLimit
} from './middleware/rateLimit';

import { env } from '../../config/env';

export function buildServer() {
  const app = Fastify({
    logger: {
      level: env.nodeEnv === 'production' ? 'info' : 'debug',
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          headers: {
            host: req.headers.host,
            'user-agent': req.headers['user-agent'],
          },
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
    },
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 300000, // 5 minutes timeout
    requestIdHeader: 'x-request-id', // Use custom header for request ID
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
  });

  // CORS configuration - production-safe
  const corsOptions = env.nodeEnv === 'production' && env.allowedOrigins
    ? {
      origin: env.allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true
    }
    : {
      origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'],
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

  // Request ID middleware - must be registered early
  app.addHook('onRequest', requestIdMiddleware);

  // Global rate limiting
  registerGlobalRateLimit(app);

  // Register request logger hooks (after request ID middleware)
  app.addHook('onRequest', requestLogger);
  app.addHook('onResponse', responseLogger);
  app.addHook('onError', errorLogger);

  // Set error handler
  app.setErrorHandler(errorHandler);

  // Register routes with specific rate limiting
  app.register(healthRoutes, { prefix: '/api' });

  // Auth routes with strict rate limiting
  app.register(async function (app) {
    registerAuthRateLimit(app);
    app.register(authRoutes);
  }, { prefix: '/api' });

  // AI routes with cost-aware rate limiting
  app.register(async function (app) {
    registerAiRateLimit(app);
    app.register(aiRoutes);
  }, { prefix: '/api' });

  // Admin routes with admin rate limiting
  app.register(async function (app) {
    registerAdminRateLimit(app);
    app.register(adminRoutes);
  }, { prefix: '/api' });

  // Other routes (use global rate limiting)
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
  app.register(gamificationRoutes, { prefix: '/api' });
  app.register(notificationRoutes, { prefix: '/api' });

  return app;
}

