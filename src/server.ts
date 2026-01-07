import { buildServer } from './infra/http/server';
import { env } from './config/env';
import { pool } from './infra/db/pool';

async function main() {
  const app = buildServer();

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
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

