import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

const assetSchema = z.object({
  key: z.string(),
  value: z.string(),
  type: z.enum(['image', 'video', 'json']).default('json'),
  status: z.enum(['active', 'draft', 'auto']).default('active'),
  meta: z.object({
    prompt: z.string().optional(),
    mode: z.string().optional(),
    source: z.string().optional(),
    createdBy: z.string().optional(),
    movementId: z.string().optional()
  }).optional()
});

// Table creation moved to migration 020_add_cached_asset_meta_table.sql
// No runtime table creation needed

export async function assetsRoutes(app: FastifyInstance) {
  app.get('/assets', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(`SELECT key, status, asset_type FROM cached_assets`);
    return rows;
  });

  app.get('/assets/:key', { preHandler: authGuard }, async (req, reply) => {
    const { key } = req.params as any;
    const decodedKey = decodeURIComponent(key);
    const { rows } = await pool.query(
      `SELECT value, asset_type FROM cached_assets WHERE key=$1 AND status IN ('active','auto') LIMIT 1`,
      [decodedKey]
    );
    if (rows.length === 0) {
      return reply.status(404).send(null);
    }
    
    const value = rows[0].value;
    const assetType = rows[0].asset_type;
    
    // Return as JSON string to maintain compatibility with frontend
    // Frontend expects string | null
    return reply.send(value);
  });

  app.post('/assets', { preHandler: authGuard }, async (req, reply) => {
    const body = assetSchema.parse(req.body);
    await pool.query(
      `INSERT INTO cached_assets(key, value, asset_type, status)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, asset_type=EXCLUDED.asset_type, status=EXCLUDED.status`,
      [body.key, body.value, body.type, body.status]
    );
    if (body.meta) {
      const { prompt, mode, source, createdBy, movementId } = body.meta;
      await pool.query(
        `INSERT INTO cached_asset_meta(key, prompt, mode, source, created_by, movement_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key) DO UPDATE SET prompt=EXCLUDED.prompt, mode=EXCLUDED.mode, source=EXCLUDED.source, created_by=EXCLUDED.created_by, movement_id=EXCLUDED.movement_id`,
        [body.key, prompt || null, mode || null, source || null, createdBy || null, movementId || null]
      );
    }
    return reply.send({ success: true });
  });

  app.post('/assets/check', { preHandler: authGuard }, async (req) => {
    const { keys } = req.body as any;
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT key, status FROM cached_assets WHERE key = ANY($1) AND status IN ('active','auto')`,
      [keys]
    );
    return rows;
  });

  app.post('/assets/batch', { preHandler: authGuard }, async (req) => {
    const { keys } = req.body as any;
    if (!Array.isArray(keys) || keys.length === 0) return {};
    const { rows } = await pool.query(
      `SELECT key, value FROM cached_assets WHERE key = ANY($1) AND status IN ('active','auto')`,
      [keys]
    );
    const result: Record<string,string> = {};
    rows.forEach(r => { result[r.key] = r.value; });
    return result;
  });

  app.post('/assets/scan', { preHandler: authGuard }, async (req) => {
    const { prefix } = req.body as any;
    const { rows } = await pool.query(
      `SELECT key FROM cached_assets WHERE key ILIKE $1 LIMIT 100`,
      [`${prefix}%`]
    );
    return rows.map(r => r.key);
  });

  // System blueprints / guidelines stored as JSON in cached_assets
  app.post('/assets/system-blueprints', { preHandler: authGuard }, async (req, reply) => {
    const key = 'system_blueprints_config';
    const value = JSON.stringify(req.body || {});
    await pool.query(
      `INSERT INTO cached_assets(key, value, asset_type, status)
       VALUES($1,$2,'json','active')
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status='active'`,
      [key, value]
    );
    return reply.send({ success: true });
  });

  app.get('/assets/system-blueprints', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT value FROM cached_assets WHERE key='system_blueprints_config' AND status IN ('active','auto') LIMIT 1`
    );
    if (rows.length === 0) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  });

  app.post('/assets/guidelines', { preHandler: authGuard }, async (req, reply) => {
    const key = 'guidelines';
    const value = JSON.stringify(req.body || {});
    await pool.query(
      `INSERT INTO cached_assets(key, value, asset_type, status)
       VALUES($1,$2,'json','active')
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status='active'`,
      [key, value]
    );
    return reply.send({ success: true });
  });

  app.get('/assets/guidelines', { preHandler: authGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT value FROM cached_assets WHERE key='guidelines' AND status IN ('active','auto') LIMIT 1`
    );
    if (rows.length === 0) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  });

  app.post('/assets/with-fallback', { preHandler: authGuard }, async (req, reply) => {
    const { baseKey, specificThemeId } = req.body as any;
    const keysToTry = specificThemeId ? [`${baseKey}_theme_${specificThemeId}`, baseKey] : [baseKey];
    const { rows } = await pool.query(
      `SELECT key, value FROM cached_assets WHERE key = ANY($1) AND status IN ('active','auto') ORDER BY status DESC LIMIT 1`,
      [keysToTry]
    );
    if (rows.length === 0) return reply.send(null);
    return rows[0].value;
  });

  app.get('/assets/meta/:key', { preHandler: authGuard }, async (req, reply) => {
    const { key } = req.params as any;
    const { rows } = await pool.query(
      `SELECT prompt, mode, source, created_by, created_at, movement_id FROM cached_asset_meta WHERE key = $1`,
      [key]
    );
    if (rows.length === 0) return reply.send(null);
    return rows[0];
  });

  app.post('/assets/by-movement', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({ movementId: z.string(), limit: z.number().min(1).max(50).optional() }).parse(req.body || {});
    const limit = body.limit || 20;
    const { rows } = await pool.query(
      `SELECT a.key, a.value, a.asset_type, a.status, a.created_at,
              m.prompt, m.mode, m.source, m.created_by, m.created_at AS meta_created_at, m.movement_id
       FROM cached_assets a
       LEFT JOIN cached_asset_meta m ON m.key = a.key
       WHERE (m.movement_id = $1 OR a.key ILIKE $2)
       ORDER BY a.created_at DESC
       LIMIT $3`,
      [body.movementId, `${body.movementId}%`, limit]
    );
    return rows;
  });
}

