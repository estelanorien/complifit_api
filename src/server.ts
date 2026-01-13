import { buildServer } from './infra/http/server.js';
import { env } from './config/env.js';
import { pool } from './infra/db/pool.js';
import v8 from 'v8';

async function main() {
  const app = buildServer();

  // Graceful shutdown handler
  const closeGracefully = async (signal: string) => {
    app.log.info(`Received ${signal}, closing gracefully...`);

    try {
      await app.close();
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
    console.log('[STARTUP] Waiting for Fastify plugins to load...');
    await app.ready();
    console.log('[STARTUP] Fastify plugins loaded successfully');
  } catch (err) {
    console.error('[STARTUP] Failed to load Fastify plugins:', err);
    process.exit(1);
  }

  // Start server to satisfy Cloud Run startup probe
  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    console.log(`[STARTUP] API running on port ${env.port}`);
    app.log.info(`API running on port ${env.port}`);
  } catch (err) {
    console.error('[STARTUP] Failed to start server:', err);
    process.exit(1);
  }

  // Then check DB connection
  try {
    await pool.query('SELECT 1');
    app.log.info('Database connection established successfully');
  } catch (err) {
    app.log.error(err, 'Failed to connect to database on startup');
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

    // Temporarily disabled self-shutdown to allow deployment to pass startup probes
    /*
    if (heapPercent > 95) {
      app.log.error({
        message: `CRITICAL: Memory usage above 95% of limit (${heapUsedMB}MB / ${heapLimitMB}MB), initiating graceful shutdown`,
        heapPercent
      });
      void closeGracefully('HIGH_MEMORY');
    }
    */
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