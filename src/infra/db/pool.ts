import { Pool } from 'pg';
import { env } from '../../config/env';

export const pool = new Pool({
  connectionString: env.databaseUrl,

  // Connection pool limits - optimized for Cloud Run
  max: 10, // ✅ Düşürdüm: 2GB memory için 10 yeterli (20 çok fazla)
  min: 1, // ✅ Düşürdüm: Minimum 1 connection yeterli

  // Idle connection management
  idleTimeoutMillis: 20000, // ✅ 20 saniyeye düşürdüm - daha agresif cleanup
  connectionTimeoutMillis: 10000,

  // Connection lifecycle
  maxUses: 5000, // ✅ 5000'e düşürdüm - daha sık rotation
  allowExitOnIdle: true, // ✅ CRITICAL: true yap - idle process'leri temizle

  // Query timeout
  statement_timeout: 30000, // ✅ YENİ: 30 saniye query timeout
  query_timeout: 30000, // ✅ YENİ: 30 saniye query timeout

  // SSL configuration
  ssl: env.nodeEnv === 'production' || env.databaseUrl.includes('104.199')
    ? { rejectUnauthorized: false }
    : undefined,

  // Keep alive settings
  keepAlive: true, // ✅ YENİ: TCP keep-alive aktif
  keepAliveInitialDelayMillis: 10000, // ✅ YENİ: 10 saniye sonra keep-alive başla
});

// Error handler - improved logging
pool.on('error', (err, client) => {
  const timestamp = new Date().toISOString();
  process.stderr.write(
    JSON.stringify({
      timestamp,
      level: 'error',
      type: 'pg_pool_error',
      message: err.message,
      stack: err.stack,
      clientInfo: client ? 'client_connected' : 'no_client'
    }) + '\n'
  );
});

// ✅ YENİ: Connection acquire/release logging (debug için)
pool.on('connect', (client) => {
  const timestamp = new Date().toISOString();
  if (env.nodeEnv !== 'production') {
    process.stdout.write(
      JSON.stringify({
        timestamp,
        level: 'debug',
        type: 'pg_pool_connect',
        message: 'New client connected',
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }) + '\n'
    );
  }
});

pool.on('remove', (client) => {
  const timestamp = new Date().toISOString();
  if (env.nodeEnv !== 'production') {
    process.stdout.write(
      JSON.stringify({
        timestamp,
        level: 'debug',
        type: 'pg_pool_remove',
        message: 'Client removed from pool',
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }) + '\n'
    );
  }
});

// ✅ YENİ: Pool stats monitoring - her 2 dakikada bir
const poolStatsInterval = setInterval(() => {
  const stats = {
    timestamp: new Date().toISOString(),
    level: 'info',
    type: 'pg_pool_stats',
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };

  process.stdout.write(JSON.stringify(stats) + '\n');

  // ✅ Eğer waiting connection varsa uyar
  if (pool.waitingCount > 0) {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'pg_pool_congestion',
        message: `${pool.waitingCount} clients waiting for connection`,
        totalCount: pool.totalCount,
        idleCount: pool.idleCount
      }) + '\n'
    );
  }
}, 120000); // 2 dakika

// ✅ Graceful shutdown handler - improved
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    process.stdout.write('Shutdown already in progress...\n');
    return;
  }

  isShuttingDown = true;

  const timestamp = new Date().toISOString();
  process.stdout.write(
    JSON.stringify({
      timestamp,
      level: 'info',
      type: 'shutdown_start',
      signal,
      poolStats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }
    }) + '\n'
  );

  // Stop monitoring interval
  clearInterval(poolStatsInterval);

  try {
    // Close pool with timeout
    const closeTimeout = setTimeout(() => {
      process.stderr.write('Pool close timeout, forcing exit...\n');
      process.exit(1);
    }, 5000);

    await pool.end();
    clearTimeout(closeTimeout);

    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        type: 'shutdown_complete',
        signal,
        message: 'Database pool closed successfully'
      }) + '\n'
    );

    process.exit(0);
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        type: 'shutdown_error',
        signal,
        error: error instanceof Error ? error.message : String(error)
      }) + '\n'
    );
    process.exit(1);
  }
};

// Note: Signal handlers (SIGTERM, SIGINT) are handled in server.ts
// Pool cleanup is done there via pool.end() during graceful shutdown

// ✅ YENİ: Health check function
export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latency: number;
  poolStats: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
}> {
  const start = Date.now();

  try {
    await pool.query('SELECT 1');
    const latency = Date.now() - start;

    return {
      healthy: true,
      latency,
      poolStats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }
    };
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - start,
      poolStats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }
    };
  }
}
