import { buildServer } from './infra/http/server';
import { env } from './config/env';
import { pool } from './infra/db/pool';

async function main() {
  const app = buildServer();

  // Basit PG check
  await pool.query('SELECT 1');

  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(`API running on port ${env.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

