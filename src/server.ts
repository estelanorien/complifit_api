import { buildServer } from './infra/http/server';
import { env } from './config/env';
import { pool } from './infra/db/pool';

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

  // Start server first to satisfy Cloud Run startup probe
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(`API running on port ${env.port}`);

  // Then check DB connection
  try {
    await pool.query('SELECT 1');
    app.log.info('Database connection established successfully');
  } catch (err) {
    app.log.error(err, 'Failed to connect to database on startup');
  }

  // Memory monitoring and auto-cleanup
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    const heapPercent = Math.round((usage.heapUsed / usage.heapTotal) * 100);

    app.log.info({
      memory: {
        heap: `${heapUsedMB}/${heapTotalMB} MB (${heapPercent}%)`,
        rss: `${rssMB} MB`,
        external: `${Math.round(usage.external / 1024 / 1024)} MB`
      },
      uptime: `${Math.round(process.uptime())}s`
    });

    // Trigger manual garbage collection if available and memory is high
    if (typeof global.gc === 'function' && heapPercent > 80) {
      app.log.info('Triggering manual GC due to high memory usage');
      try {
        global.gc();
      } catch (err) {
        app.log.error(err, 'Error during manual GC');
      }
    }

    // Critical threshold - initiate graceful shutdown
    if (heapPercent > 93) {
      app.log.error({
        message: 'CRITICAL: Memory usage above 93%, initiating graceful shutdown',
        heapPercent
      });
      void closeGracefully('HIGH_MEMORY');
    }
  }, 30000); // Every 30 seconds

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