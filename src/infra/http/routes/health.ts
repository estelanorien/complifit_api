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

  // TEMPORARY: Pre-batch diagnostic endpoint (remove after verification)
  app.get('/health/preflight', async (req, reply) => {
    const results: Record<string, any> = {};

    try {
      // 1. Coach reference images
      const coachRes = await pool.query(
        "SELECT key, length(value) as value_len, status FROM cached_assets WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref')"
      );
      results.coachImages = coachRes.rows.length > 0
        ? coachRes.rows.map((r: any) => ({ key: r.key, sizeKB: Math.round(r.value_len / 1024), status: r.status }))
        : 'NOT_FOUND';

      // 2. Status constraint check
      const constraintRes = await pool.query(
        "SELECT pg_get_constraintdef(oid) as def FROM pg_constraint WHERE conname = 'cached_assets_status_check'"
      );
      results.statusConstraint = constraintRes.rows.length > 0
        ? { exists: true, includesFailed: constraintRes.rows[0].def.includes("'failed'"), def: constraintRes.rows[0].def }
        : { exists: false };

      // 3. Migrations applied
      try {
        const migRes = await pool.query("SELECT count(*) as cnt FROM _migrations");
        results.migrationsApplied = parseInt(migRes.rows[0].cnt);
      } catch { results.migrationsApplied = 'NO_TRACKING_TABLE'; }

      // 4. Key tables check
      const tablesRes = await pool.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        AND tablename IN ('cached_assets','asset_blob_storage','cached_asset_meta',
          'video_jobs','video_source_clips','localized_videos','content_translations',
          'translation_jobs','generation_jobs','pipeline_status','dead_letter_queue')
      `);
      const found = tablesRes.rows.map((r: any) => r.tablename);
      const required = ['cached_assets','asset_blob_storage','cached_asset_meta','video_jobs',
        'video_source_clips','localized_videos','content_translations','translation_jobs',
        'generation_jobs','pipeline_status','dead_letter_queue'];
      results.tables = { found: found.length, missing: required.filter(t => !found.includes(t)) };

      // 5. YouTube env check
      results.youtube = {
        clientId: !!process.env.YOUTUBE_CLIENT_ID,
        clientSecret: !!process.env.YOUTUBE_CLIENT_SECRET,
        refreshToken: !!process.env.YOUTUBE_REFRESH_TOKEN
      };

      // 6. GCS check
      results.gcs = {
        credentialsFile: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
        bucket: process.env.GCS_VIDEO_BUCKET || 'vitality-videos (default)'
      };

      // 7. Anthropic key
      results.anthropicKey = !!process.env.ANTHROPIC_API_KEY;

      return reply.send({ preflight: 'ok', results });
    } catch (e: any) {
      return reply.status(500).send({ preflight: 'error', message: e.message });
    }
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
