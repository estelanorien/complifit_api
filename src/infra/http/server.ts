import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { profileRoutes } from './routes/profiles.js';
import { socialRoutes } from './routes/social.js';
import { restaurantRoutes } from './routes/restaurants.js';
import { logsRoutes } from './routes/logs.js';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { challengesRoutes } from './routes/challenges.js';
import { messagesRoutes } from './routes/messages.js';
import { moderationRoutes } from './routes/moderation.js';
import { assetsRoutes } from './routes/assets.js';
import { usersRoutes } from './routes/users.js';
import { plansRoutes } from './routes/plans.js';
import { guardianRoutes } from './routes/guardian.js';
import { adminRoutes } from './routes/admin.js';
import { calorieBankRoutes } from './routes/calorieBank.js';
import { trainingRoutes } from './routes/training.js';
import { nutritionRoutes } from './routes/nutrition.js';
import { groceryRoutes } from './routes/grocery.js';
import { rehabRoutes } from './routes/rehab.js';
import { coachRoutes } from './routes/coach.js';
import { behaviorRoutes } from './routes/behavior.js';
import { inventoryRoutes } from './routes/inventory.js';
import { subscriptionRoutes } from './routes/subscription.js';
import { timelineRoutes } from './routes/timeline.js';
import { negotiationRoutes } from './routes/negotiations.js';
import { lookupRoutes } from './routes/lookups.js';
import { locationRoutes } from './routes/location.js';
import { gamificationRoutes } from './routes/gamification.js';
import { notificationRoutes } from './routes/notifications.js';
import { socialAuthRoutes } from './routes/socialAuth.js';
import { customProgramRoutes } from './routes/customPrograms.js';
import { jobRoutes } from './routes/jobs.js';
import videoAdminRoutes from './routes/videoAdmin.js';
import { requestLogger, responseLogger, errorLogger } from './hooks/requestLogger.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler } from './middleware/errors.js';
import {
  registerGlobalRateLimit,
  registerAuthRateLimit,
  registerAiRateLimit,
  registerAdminRateLimit
} from './middleware/rateLimit.js';

import { env } from '../../config/env.js';

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
    bodyLimit: 2 * 1024 * 1024, // 2MB - reduced from 10MB to prevent DoS
    requestTimeout: 300000, // 5 minutes timeout
    requestIdHeader: 'x-request-id', // Use custom header for request ID
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
    trustProxy: true // CRITICAL: Required for Cloud Run/Load Balancers to forward real IPs
  });

  // CORS configuration - production-safe
  const corsOptions = env.nodeEnv === 'production' && env.allowedOrigins
    ? {
      origin: env.allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true
    }
    : {
      origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174', 'http://localhost:3001', 'http://localhost:3005'],
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
    app.register(socialAuthRoutes);
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
    app.register(videoAdminRoutes);
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
  app.register(groceryRoutes, { prefix: '/api' });
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
  app.register(subscriptionRoutes, { prefix: '/api' });
  app.register(customProgramRoutes, { prefix: '/api' });
  app.register(jobRoutes, { prefix: '/api' });

  return app;
}

