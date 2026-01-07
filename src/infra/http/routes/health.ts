import { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (req, reply) => {
    const checks: Record<string, { status: string; message?: string; latency?: number }> = {};
    let overallStatus = 'healthy';

    // Database check
    try {
      const dbStart = Date.now();
      await pool.query('SELECT 1');
      const dbLatency = Date.now() - dbStart;
      checks.database = {
        status: 'healthy',
        latency: dbLatency,
        message: dbLatency > 1000 ? 'Slow response' : undefined
      };
      if (dbLatency > 1000) overallStatus = 'degraded';
    } catch (e: any) {
      checks.database = {
        status: 'unhealthy',
        message: e.message || 'Database connection failed'
      };
      overallStatus = 'unhealthy';
    }

    // Memory check
    const memUsage = process.memoryUsage();
    const memUsageMB = {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024)
    };
    
    // Warn if heap usage is above 80%
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    if (heapUsagePercent > 80) {
      checks.memory = {
        status: 'degraded',
        message: `High memory usage: ${Math.round(heapUsagePercent)}%`
      };
      if (overallStatus === 'healthy') overallStatus = 'degraded';
    } else {
      checks.memory = {
        status: 'healthy',
        message: `Heap usage: ${Math.round(heapUsagePercent)}%`
      };
    }

    const statusCode = overallStatus === 'unhealthy' ? 503 : overallStatus === 'degraded' ? 200 : 200;
    
    return reply.status(statusCode).send({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      checks,
      memory: memUsageMB
    });
  });
}

