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
  console.error('Unexpected PG pool error', err);
  // In production, you might want to send this to an error tracking service
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database pool...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing database pool...');
  await pool.end();
  process.exit(0);
});

