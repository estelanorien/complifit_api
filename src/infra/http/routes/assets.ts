import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { canonicalService } from '../../../application/services/canonicalService.js';
import { AssetRepository } from '../../db/repositories/AssetRepository.js';
import { UnifiedKey } from '../../../domain/UnifiedKey.js';
import { AssetPromptService } from '../../../application/services/assetPromptService.js';
import { MovementRepository } from '../../db/repositories/MovementRepository.js';
import { UnifiedAssetService } from '../../../application/services/UnifiedAssetService.js';

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
  app.get('/assets', { preHandler: authGuard }, async (req: any, reply: any) => {
    const { rows } = await pool.query(`SELECT key, status, asset_type FROM cached_assets`);
    return rows;
  });


  app.get('/assets/:key', { preHandler: authGuard }, async (req: any, reply: any) => {
    const { key } = req.params as any;
    try {
      const decodedKey = decodeURIComponent(key);

      // 1. Search for asset via Repository
      const asset = await AssetRepository.findByKey(decodedKey);

      if (asset) {
        let { buffer, asset_type, status, metadata } = asset;
        let value = buffer ? buffer.toString() : '';

        // If image, ensure base64 prefix
        if (asset_type === 'image' && value && !value.startsWith('data:image')) {
          value = `data:image/png;base64,${value}`;
        }

        // Return immediately if active/generating
        if (status === 'active' || status === ('auto' as any) || status === 'generating') {
          return {
            value,
            assetType: asset_type,
            status,
            textContext: metadata?.text_context || '',
            textContextSimple: metadata?.text_context_simple || ''
          };
        }
      }

      // 2. TRIGGER SMART DISCOVERY (On-demand restoration)
      const isExercise = decodedKey.startsWith('ex_');
      const isMeal = decodedKey.startsWith('meal_');

      if (isExercise || isMeal) {
        let movementSlug = decodedKey;
        if (isExercise) {
          movementSlug = decodedKey.replace(/^ex_/, '').replace(/_(atlas|nova|mannequin)_(main|step_\d+)$/, '').replace(/_meta$/, '');
        } else {
          movementSlug = decodedKey.replace(/^meal_/, '').replace(/_(main|step_\d+)$/, '').replace(/_meta$/, '');
        }

        const tableName = isExercise ? 'training_exercises' : 'meals';
        const searchPattern = movementSlug.replace(/_/g, '%');

        req.log.info(`[Proxy] Discovery Attempt: ${decodedKey} -> Slug: ${movementSlug}`);

        const groupRes = await pool.query(
          `SELECT id, name FROM ${tableName} 
           WHERE name ILIKE $1 
              OR REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '_', 'g') = $2
              OR REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '_', 'g') LIKE $3
              OR name ILIKE $4
           ORDER BY length(name) ASC
           LIMIT 1`,
          [movementSlug.replace(/_/g, ' '), movementSlug, `%${movementSlug}%`, `%${searchPattern}%`]
        );

        if (groupRes.rows.length > 0) {
          const { id, name } = groupRes.rows[0];
          req.log.info(`[Proxy] Discovery SUCCESS: ${name} (${id})`);

          // Background generation is handled by Admin explicitly now
          const isMeta = decodedKey.endsWith('_meta');
          return {
            value: isMeta ? {} : '',
            assetType: isMeta ? 'json' : 'image',
            status: 'generating'
          };
        }
      }

      return reply.status(404).send({ error: 'Asset not found' });
    } catch (error: any) {
      req.log.error({ error: 'GET /assets/:key failed', key, message: error.message });
      return reply.status(500).send({ error: error.message || 'Internal server error' });
    }
  });

  app.post('/assets', { preHandler: authGuard }, async (req: any, reply: any) => {
    try {
      const body = assetSchema.parse(req.body);

      // Validate value is not empty for non-draft status
      if (body.status !== 'draft' && (!body.value || body.value.trim() === '')) {
        req.log.warn({ error: 'Empty value for non-draft asset', key: body.key });
        return reply.status(400).send({ error: 'Value cannot be empty for non-draft assets' });
      }

      // Insert or update asset
      try {
        await AssetRepository.save(body.key, {
          value: body.value,
          status: body.status as any,
          type: body.type as any
        });
      } catch (dbError: any) {
        req.log.error({
          error: 'Failed to insert/update cached_assets via Repository',
          key: body.key,
          dbError: dbError.message,
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
    
    // FIX: Return full asset data including status and metadata for frontend
    const { rows } = await pool.query(
      `SELECT 
        a.key, 
        a.value, 
        a.asset_type,
        a.status,
        m.text_context,
        m.text_context_simple
      FROM cached_assets a
      LEFT JOIN cached_asset_meta m ON m.key = a.key
      WHERE a.key = ANY($1) AND a.status IN ('active','auto','draft','generating')
      LIMIT 100`,
      [keys]
    );
    
    const result: Record<string, any> = {};
    rows.forEach((r: any) => {
      let value = r.value || '';
      // If image, ensure base64 prefix
      if (r.asset_type === 'image' && value && !value.startsWith('data:image')) {
        value = `data:image/png;base64,${value}`;
      }
      
      result[r.key] = {
        value,
        assetType: r.asset_type,
        status: r.status,
        textContext: r.text_context || '',
        textContextSimple: r.text_context_simple || ''
      };
    });
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

  app.post('/assets/by-movement', { preHandler: authGuard }, async (req: any, reply: any) => {
    // Ensure CORS headers are set for this route
    const origin = req.headers.origin || '*';
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'false');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id, x-goog-api-key, x-api-key');

    try {
      const body = z.object({ movementId: z.string(), limit: z.number().min(1).max(100).optional() }).parse(req.body || {});
    const limit = body.limit || 100;

    // CRITICAL FIX: Keep original movementId for pattern searches
    // The canonical service was changing the ID which caused searches to fail
    const originalMovementId = body.movementId;
    req.log.info(`[by-movement] Query for movementId: ${originalMovementId}, limit: ${limit}`);

    // FIX: Search for keys with COLON separators (UnifiedKey format: type:id:persona:subtype:index)
    // Keys are stored as ex:movement_id:atlas:main:0, meal:movement_id:none:step:1, etc.
    // Use ORIGINAL movementId for ALL pattern matches - don't let canonical service change it
    req.log.info(`[by-movement] Searching with patterns: ex:${originalMovementId}:%, meal:${originalMovementId}:%`);

    // CRITICAL FIX: Join asset_blob_storage to get actual image data
    // Images are stored in asset_blob_storage.data, NOT in cached_assets.value
    // BUT: For JSON assets (like meta), use a.value directly - don't return blob data
    const { rows } = await pool.query(
      `SELECT a.key, 
               CASE 
                 WHEN a.asset_type = 'image' THEN COALESCE(ENCODE(b.data, 'base64'), a.value)
                 ELSE a.value
               END as value,
               a.asset_type, a.status, a.created_at,
               m.prompt, m.mode, m.source, m.created_by, m.created_at AS meta_created_at, m.movement_id,
               m.translation_status, m.translation_error,
               m.video_status, m.video_error,
               m.text_context, m.text_context_simple, m.step_index, m.persona
        FROM cached_assets a
        LEFT JOIN cached_asset_meta m ON m.key = a.key
        LEFT JOIN asset_blob_storage b ON b.key = a.key
        WHERE m.movement_id = $1 
           OR a.key LIKE $2 
           OR a.key LIKE $3
           OR a.key LIKE $4
           OR a.key LIKE $5
           OR a.key LIKE $6
        ORDER BY a.created_at DESC
        LIMIT $7`,
      [originalMovementId, `ex:${originalMovementId}:%`, `meal:${originalMovementId}:%`, `ex_${originalMovementId}%`, `meal_${originalMovementId}%`, `${originalMovementId}%`, limit]
    );

    req.log.info(`[by-movement] Found ${rows.length} rows for ${originalMovementId}`);
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

    // DEBUG: Log what we're returning
    req.log.info({
      message: '[by-movement] Returning data',
      movementId: originalMovementId,
      totalRows: processedRows.length,
      keys: processedRows.map((r: any) => r.key),
      hasTextContext: processedRows.filter((r: any) => r.text_context || r.text_context_simple).length,
      metaJsonKeys: processedRows.filter((r: any) => r.key?.includes(':meta:') || r.key?.endsWith('_meta')).map((r: any) => r.key)
    });

      return processedRows;
    } catch (e: any) {
      req.log.error({ err: e }, '[by-movement] Error');
      return reply.status(500).send({
        error: e.message || 'Internal server error',
        requestId: (req as any).requestId || 'unknown'
      });
    }
  });
}

// Force rebuild 2026-01-19
