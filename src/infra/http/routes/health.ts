import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, checkDatabaseHealth } from '../../db/pool.js';
import { authGuard } from '../hooks/auth.js';
import { AuthenticatedRequest } from '../types.js';

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
    } catch (e: unknown) {
      const error = e as Error;
      checks.database = {
        status: 'unhealthy',
        message: error.message || 'Database connection failed',
        pool: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount
        }
      };
      overallStatus = 'unhealthy';
    }

    // Memory check - improved thresholds using v8 statistics
    const v8 = await import('v8');
    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();

    const memUsageMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapLimit: Math.round(heapStats.heap_size_limit / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024)
    };

    // Calculate heap usage percentage relative to LIMIT, not current total
    const heapUsagePercent = (memUsage.heapUsed / heapStats.heap_size_limit) * 100;

    // More aggressive memory thresholds against the actual limit
    if (heapUsagePercent > 90) {
      checks.memory = {
        status: 'unhealthy',
        message: `Critical memory usage: ${Math.round(heapUsagePercent)}% of ${memUsageMB.heapLimit}MB`
      };
      overallStatus = 'unhealthy';
    } else if (heapUsagePercent > 80) {
      checks.memory = {
        status: 'degraded',
        message: `High memory usage: ${Math.round(heapUsagePercent)}% of ${memUsageMB.heapLimit}MB`
      };
      if (overallStatus === 'healthy') overallStatus = 'degraded';
    } else {
      checks.memory = {
        status: 'healthy',
        message: `Heap usage: ${Math.round(heapUsagePercent)}% of ${memUsageMB.heapLimit}MB`
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
      version: '1.0.1-fixed-mem-check',
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
    } catch (e: unknown) {
      const error = e as Error;
      return reply.status(503).send({
        status: 'not_ready',
        reason: 'db_error',
        error: error.message
      });
    }
  });

  // --- Metabolic Health Endpoints ---

  // Get metabolic alerts (stored in profile_data.metabolicAlerts)
  app.get('/health/metabolic/alerts', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    try {
      const { rows } = await pool.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
        [user.userId]
      );

      const profileData = rows[0]?.profile_data || {};
      const alerts = (profileData.metabolicAlerts || []).filter(
        (a: { status?: string }) => a.status === 'active'
      );

      return reply.send(alerts);
    } catch (e: unknown) {
      req.log.error(e);
      return reply.send([]);
    }
  });

  // Resolve a metabolic alert
  app.post('/health/metabolic/resolve', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({
      alertId: z.string(),
      action: z.string()
    }).parse(req.body);

    try {
      const { rows } = await pool.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
        [user.userId]
      );

      const profileData = rows[0]?.profile_data || {};
      const alerts = profileData.metabolicAlerts || [];
      const idx = alerts.findIndex((a: { id?: string }) => a.id === body.alertId);

      if (idx >= 0) {
        alerts[idx].status = 'resolved';
        alerts[idx].resolvedAt = new Date().toISOString();
        alerts[idx].resolvedAction = body.action;
        profileData.metabolicAlerts = alerts;

        await pool.query(
          `UPDATE user_profiles SET profile_data = $1::jsonb, updated_at = now() WHERE user_id = $2`,
          [JSON.stringify(profileData), user.userId]
        );
      }

      return reply.send({ success: true });
    } catch (e: unknown) {
      req.log.error(e);
      return reply.status(500).send({ error: 'Failed to resolve alert' });
    }
  });

  // Apply diet break (mark in profile for planner to pick up)
  app.post('/planner/diet-break', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    try {
      await pool.query(
        `UPDATE user_profiles
         SET profile_data = jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{dietBreak}',
           $1::jsonb
         ),
         updated_at = now()
         WHERE user_id = $2`,
        [JSON.stringify({ active: true, startedAt: new Date().toISOString() }), user.userId]
      );

      return reply.send({ success: true });
    } catch (e: unknown) {
      req.log.error(e);
      return reply.status(500).send({ error: 'Failed to apply diet break' });
    }
  });
}
