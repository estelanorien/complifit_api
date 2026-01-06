import { Pool } from 'pg';
import { env } from '../../config/env';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 20, // Increased for production
  min: 2, // Keep minimum connections alive
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Timeout after 10 seconds if connection cannot be established
  maxUses: 7500, // Close (and replace) a connection after it has been used this many times
  allowExitOnIdle: false // Don't allow process to exit while clients are connected
});

pool.on('error', (err) => {
  // Note: This will be logged by Fastify's logger when pool is used in routes
  // For standalone errors, we use process stderr
  process.stderr.write(`Unexpected PG pool error: ${err.message}\n`);
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  process.stdout.write('SIGTERM received, closing database pool...\n');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  process.stdout.write('SIGINT received, closing database pool...\n');
  await pool.end();
  process.exit(0);
});

