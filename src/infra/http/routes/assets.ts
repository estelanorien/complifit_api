import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';

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
    try {
      const decodedKey = decodeURIComponent(key);

      const { rows } = await pool.query(
        `SELECT value, asset_type, status FROM cached_assets WHERE key=$1 AND status IN ('active','auto','draft','generating','failed') LIMIT 1`,
        [decodedKey]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Asset not found' });
      }

      const value = rows[0].value;
      const assetType = rows[0].asset_type;
      const status = rows[0].status;

      return { value, assetType, status };
    } catch (error: any) {
      req.log.error({
        error: 'GET /assets/:key failed',
        key,
        message: error.message,
        requestId: (req as any).requestId
      });
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  app.post('/assets', { preHandler: authGuard }, async (req, reply) => {
    try {
      const body = assetSchema.parse(req.body);

      // Validate value is not empty for non-draft status
      if (body.status !== 'draft' && (!body.value || body.value.trim() === '')) {
        req.log.warn({ error: 'Empty value for non-draft asset', key: body.key });
        return reply.status(400).send({ error: 'Value cannot be empty for non-draft assets' });
      }

      // Insert or update asset
      try {
        await pool.query(
          `INSERT INTO cached_assets(key, value, asset_type, status)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, asset_type=EXCLUDED.asset_type, status=EXCLUDED.status`,
          [body.key, body.value, body.type, body.status]
        );
      } catch (dbError: any) {
        req.log.error({
          error: 'Failed to insert/update cached_assets',
          key: body.key,
          dbError: dbError.message,
          code: dbError.code,
          requestId: (req as any).requestId
        });

        // Provide user-friendly error messages
        if (dbError.code === '23505') {
          return reply.status(409).send({ error: 'Asset key already exists' });
        } else if (dbError.code === '23514') {
          return reply.status(400).send({ error: `Invalid asset type or status: ${dbError.message}` });
        } else {
          return reply.status(500).send({ error: `Database error: ${dbError.message}` });
        }
      }

      // Insert or update metadata if provided
      if (body.meta) {
        const { prompt, mode, source, createdBy, movementId } = body.meta;
        try {
          await pool.query(
            `INSERT INTO cached_asset_meta(key, prompt, mode, source, created_by, movement_id)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT (key) DO UPDATE SET prompt=EXCLUDED.prompt, mode=EXCLUDED.mode, source=EXCLUDED.source, created_by=EXCLUDED.created_by, movement_id=EXCLUDED.movement_id`,
            [body.key, prompt || null, mode || null, source || null, createdBy || null, movementId || null]
          );
        } catch (metaError: any) {
          req.log.error({
            error: 'Failed to insert/update cached_asset_meta',
            key: body.key,
            metaError: metaError.message,
            code: metaError.code,
            requestId: (req as any).requestId
          });
          // Don't fail the whole request if metadata insert fails
          // Asset was saved successfully
        }
      }

      return reply.send({ success: true });
    } catch (error: any) {
      req.log.error({
        error: 'POST /assets failed',
        message: error.message,
        stack: error.stack,
        requestId: (req as any).requestId
      });

      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: error.errors
        });
      }

      return reply.status(500).send({
        error: error.message || 'Internal server error'
      });
    }
  });

  app.post('/assets/check', { preHandler: authGuard }, async (req) => {
    const { keys } = req.body as any;
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT key, status FROM cached_assets WHERE key = ANY($1) AND status IN ('active','auto','draft')`,
      [keys]
    );
    return rows;
  });

  app.post('/assets/batch', { preHandler: authGuard }, async (req) => {
    const { keys } = req.body as any;
    if (!Array.isArray(keys) || keys.length === 0) return {};
    const { rows } = await pool.query(
      `SELECT key, value FROM cached_assets WHERE key = ANY($1) AND status IN ('active','auto','draft')`,
      [keys]
    );
    const result: Record<string, string> = {};
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
    const key = 'system_blueprints';
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
      `SELECT value FROM cached_assets WHERE key='system_blueprints' AND status IN ('active','auto') LIMIT 1`
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
      `SELECT key, value, asset_type FROM cached_assets WHERE key = ANY($1) AND status IN ('active','auto') ORDER BY status DESC LIMIT 1`,
      [keysToTry]
    );
    if (rows.length === 0) return reply.send(null);

    const value = rows[0].value;
    // If it's an image (base64 string), send it directly as text to avoid JSON serialization
    if (rows[0].asset_type === 'image' && typeof value === 'string' && value.startsWith('data:image')) {
      reply.type('text/plain');
      return reply.send(value);
    }
    return reply.send(value);
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
              m.prompt, m.mode, m.source, m.created_by, m.created_at AS meta_created_at, m.movement_id,
              m.translation_status, m.translation_error,
              m.video_status, m.video_error
       FROM cached_assets a
       LEFT JOIN cached_asset_meta m ON m.key = a.key
       WHERE (m.movement_id = $1 OR a.key ILIKE $2)
       ORDER BY a.created_at DESC
       LIMIT $3`,
      [body.movementId, `%${body.movementId}%`, limit]
    );
    // Ensure image values have proper data:image prefix for frontend display
    const processedRows = rows.map((row: any) => {
      if (row.asset_type === 'image' && row.value && typeof row.value === 'string') {
        // If value doesn't have data:image prefix, add it
        if (!row.value.startsWith('data:image')) {
          // Check if it's base64 (starts with valid base64 chars)
          if (/^[A-Za-z0-9+/=]+$/.test(row.value)) {
            row.value = `data:image/png;base64,${row.value}`;
          }
        }
      }
      return row;
    });
    return processedRows;
  });
}

