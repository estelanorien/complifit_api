import { FastifyInstance } from 'fastify';
import { pool, checkDatabaseHealth } from '../../db/pool';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (req, reply) => {
    const checks: Record<string, {
      status: string;
      message?: string;
      latency?: number;
      pool?: {
        totalCount: number;
        idleCount: number;
        waitingCount: number;
      };
    }> = {};

    let overallStatus = 'healthy';

    // Database check - use new health check function
    try {
      const dbHealth = await checkDatabaseHealth();

      checks.database = {
        status: dbHealth.healthy ? 'healthy' : 'unhealthy',
        latency: dbHealth.latency,
        pool: dbHealth.poolStats,
        message: dbHealth.latency > 1000
          ? 'Slow response'
          : dbHealth.poolStats.waitingCount > 0
            ? `${dbHealth.poolStats.waitingCount} clients waiting`
            : undefined
      };

      // Set degraded if DB is slow or has waiting connections
      if (!dbHealth.healthy) {
        overallStatus = 'unhealthy';
      } else if (dbHealth.latency > 1000 || dbHealth.poolStats.waitingCount > 0) {
        overallStatus = 'degraded';
      }
    } catch (e: any) {
      checks.database = {
        status: 'unhealthy',
        message: e.message || 'Database connection failed',
        pool: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount
        }
      };
      overallStatus = 'unhealthy';
    }

    // Memory check - improved thresholds
    const memUsage = process.memoryUsage();
    const memUsageMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024)
    };

    // Calculate heap usage percentage
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    // More aggressive memory thresholds
    if (heapUsagePercent > 90) {
      checks.memory = {
        status: 'degraded',
        message: `Critical memory usage: ${Math.round(heapUsagePercent)}%`
      };
      if (overallStatus === 'healthy') overallStatus = 'degraded';
    } else if (heapUsagePercent > 80) {
      checks.memory = {
        status: 'degraded',
        message: `High memory usage: ${Math.round(heapUsagePercent)}%`
      };
      if (overallStatus === 'healthy') overallStatus = 'degraded';
    } else if (heapUsagePercent > 70) {
      checks.memory = {
        status: 'healthy',
        message: `Elevated memory usage: ${Math.round(heapUsagePercent)}%`
      };
    } else {
      checks.memory = {
        status: 'healthy',
        message: `Heap usage: ${Math.round(heapUsagePercent)}%`
      };
    }

    // Additional system checks
    const uptimeSeconds = Math.round(process.uptime());
    const uptimeHours = (uptimeSeconds / 3600).toFixed(1);

    // Warn if uptime is very high (might indicate memory accumulation)
    if (uptimeSeconds > 86400) { // 24 hours
      checks.uptime = {
        status: 'degraded',
        message: `High uptime: ${uptimeHours}h - consider restart`
      };
    }

    const statusCode = overallStatus === 'unhealthy' ? 503 : 200;

    return reply.status(statusCode).send({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: uptimeSeconds,
      checks,
      memory: memUsageMB,
      // Add process info for debugging
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      }
    });
  });

  // ✅ YENİ: Liveness probe endpoint (sadece "çalışıyor mu" kontrolü)
  app.get('/healthz', async (req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // ✅ YENİ: Readiness probe endpoint (traffic alabilir mi kontrolü)
  app.get('/ready', async (req, reply) => {
    try {
      // Quick DB check
      const start = Date.now();
      await pool.query('SELECT 1');
      const latency = Date.now() - start;

      // Memory check
      const memUsage = process.memoryUsage();
      const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

      // Ready if DB responds quickly and memory is not critical
      if (latency < 2000 && heapUsagePercent < 95) {
        return reply.status(200).send({
          status: 'ready',
          latency,
          memoryUsage: Math.round(heapUsagePercent)
        });
      } else {
        return reply.status(503).send({
          status: 'not_ready',
          reason: latency >= 2000 ? 'slow_db' : 'high_memory',
          latency,
          memoryUsage: Math.round(heapUsagePercent)
        });
      }
    } catch (e: any) {
      return reply.status(503).send({
        status: 'not_ready',
        reason: 'db_error',
        error: e.message
      });
    }
  });
}