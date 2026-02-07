import { buildServer } from './infra/http/server.js';
import { env } from './config/env.js';
import { pool } from './infra/db/pool.js';
import { jobProcessor } from './application/services/jobProcessor.js';
import { translationQueue } from './application/services/translationQueueService.js';
import { videoQueue } from './application/services/videoQueueService.js';
import { initializeFirebase } from './services/firebaseService.js';
import v8 from 'v8';

async function main() {
  const app = buildServer();

  // Graceful shutdown handler
  const closeGracefully = async (signal: string) => {
    app.log.info(`Received ${signal}, closing gracefully...`);

    try {
      await app.close();
      jobProcessor.stop();
      translationQueue.stop();
      videoQueue.stop();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void closeGracefully('SIGTERM'));
  process.on('SIGINT', () => void closeGracefully('SIGINT'));

  // Ensure all plugins are ready before listening
  try {
    app.log.info('[STARTUP] Waiting for Fastify plugins to load...');
    await app.ready();
    app.log.info('[STARTUP] Fastify plugins loaded successfully');

    // Initialize Firebase for FCM push notifications
    const firebaseReady = initializeFirebase();
    if (firebaseReady) {
      app.log.info('[STARTUP] Firebase initialized successfully');
    } else {
      app.log.warn('[STARTUP] Firebase not initialized - FCM notifications disabled');
    }

    // Start Background Workers
    jobProcessor.start();
    translationQueue.start();
    videoQueue.start();

    // Check YouTube credentials (non-blocking)
    if (env.youtube?.clientId && env.youtube?.clientSecret && env.youtube?.refreshToken) {
      import('./services/youtubeService.js').then(async ({ youtubeService }) => {
        if (youtubeService?.validateCredentials) {
          const result = await youtubeService.validateCredentials();
          if (result.valid) {
            app.log.info('[STARTUP] YouTube credentials validated successfully');
          } else {
            app.log.error(`[STARTUP] YouTube credentials INVALID: ${result.error}. Video uploads will fail.`);
          }
        } else {
          app.log.info('[STARTUP] YouTube service loaded (legacy mode, no pre-validation)');
        }
      }).catch(err => {
        app.log.warn(`[STARTUP] YouTube credential check skipped: ${(err as Error).message}`);
      });
    } else {
      app.log.warn('[STARTUP] YouTube credentials not configured - auto-upload disabled');
    }
  } catch (err) {
    app.log.error(err, '[STARTUP] Failed to load Fastify plugins');
    process.exit(1);
  }

  // Verify database connection BEFORE starting server
  try {
    await pool.query('SELECT 1');
    app.log.info('[STARTUP] Database connection verified successfully');
  } catch (err) {
    app.log.error(err, '[STARTUP] Failed to connect to database - server will start but DB calls will fail');
    // Don't exit - allow startup probe to pass, DB may recover
  }

  // Start server
  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info(`[STARTUP] API running on port ${env.port}`);
  } catch (err) {
    app.log.error(err, '[STARTUP] Failed to start server');
    process.exit(1);
  }

  // Memory monitoring and auto-cleanup
  setInterval(() => {
    const heapStats = v8.getHeapStatistics();
    const usage = process.memoryUsage();

    // Calculate percentage against ACTUAL system limit, not current allocated total
    const heapPercent = Math.round((usage.heapUsed / heapStats.heap_size_limit) * 100);
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);

    // Logging memory for debugging
    app.log.info({
      memory: {
        heap: `${heapUsedMB}/${heapLimitMB} MB (${heapPercent}%)`,
        rss: `${Math.round(usage.rss / 1024 / 1024)} MB`,
        total: `${Math.round(usage.heapTotal / 1024 / 1024)} MB`
      },
      uptime: `${Math.round(process.uptime())}s`
    });

    // Memory safety: graceful shutdown when approaching OOM
    if (heapPercent > 95) {
      app.log.error({
        message: `CRITICAL: Memory usage above 95% of limit (${heapUsedMB}MB / ${heapLimitMB}MB), initiating graceful shutdown`,
        heapPercent
      });
      void closeGracefully('HIGH_MEMORY');
    } else if (heapPercent > 85) {
      app.log.warn({
        message: `WARNING: Memory usage above 85% of limit (${heapUsedMB}MB / ${heapLimitMB}MB)`,
        heapPercent
      });
    }
  }, 60000); // Check every minute instead of 30s

  // Periodic light GC if available
  if (typeof global.gc === 'function') {
    setInterval(() => {
      try {
        if (global.gc) {
          global.gc();
        }
        app.log.debug('Periodic GC executed');
      } catch (err) {
        app.log.error(err, 'Error during periodic GC');
      }
    }, 120000); // Every 2 minutes

    app.log.info('Manual GC available and scheduled');
  } else {
    app.log.warn('Manual GC not available. Start with --expose-gc flag for better memory management');
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
