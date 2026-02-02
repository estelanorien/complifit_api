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
        let { buffer, asset_type, status, metadata, value: dbValue } = asset;
        let value = dbValue || '';
        
        // CRITICAL FIX: If buffer exists (from asset_blob_storage), convert it to base64
        // buffer.toString() without encoding returns binary data with null bytes
        if (buffer && Buffer.isBuffer(buffer)) {
          if (asset_type === 'image') {
            // Convert binary PNG buffer to base64 string
            value = buffer.toString('base64');
          } else if (asset_type === 'json') {
            // For JSON, convert buffer to UTF-8 string
            value = buffer.toString('utf-8');
          } else {
            // For other types, use base64
            value = buffer.toString('base64');
          }
        }

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

  app.post('/assets/batch', { preHandler: authGuard }, async (req: any, reply: any) => {
    const rawBody = req.body;
    const keys: string[] = (rawBody && typeof rawBody === 'object' && Array.isArray((rawBody as any).keys))
      ? (rawBody as any).keys
      : Array.isArray(rawBody)
        ? (rawBody as string[])
        : [];
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assets.ts:220',message:'batch entry',data:{keysCount:keys.length,firstKey:keys[0]??null},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(()=>{});
    // #endregion
    if (keys.length === 0) {
      try { return reply.send({}); } catch (_) { return; }
    }

    try {
      const client = await pool.connect();
      let rows: any[];
      try {
        await client.query(`SET statement_timeout = '60000'`);
        const res = await client.query(
          `SELECT a.key, a.value, a.asset_type, a.status, b.data as buffer, m.text_context, m.text_context_simple
           FROM cached_assets a
           LEFT JOIN asset_blob_storage b ON a.key = b.key
           LEFT JOIN cached_asset_meta m ON m.key = a.key
           WHERE a.key = ANY($1) AND a.status IN ('active','auto','draft','generating')
           LIMIT 100`,
          [keys]
        );
        rows = res.rows;
      } catch (queryErr: any) {
        req.log?.warn({ err: queryErr }, '[assets/batch] Main query failed, trying fallback (no meta join)');
        try {
          const fallbackRes = await client.query(
            `SELECT a.key, a.value, a.asset_type, a.status, b.data as buffer
             FROM cached_assets a
             LEFT JOIN asset_blob_storage b ON a.key = b.key
             WHERE a.key = ANY($1) AND a.status IN ('active','auto','draft','generating')
             LIMIT 100`,
            [keys]
          );
          rows = fallbackRes.rows.map((r: any) => ({ ...r, text_context: null, text_context_simple: null }));
        } catch (fallbackErr: any) {
          req.log?.warn({ err: fallbackErr }, '[assets/batch] Fallback failed, returning empty');
          rows = [];
        }
      } finally {
        client.release();
      }

      const result: Record<string, any> = {};
      rows.forEach((r: any) => {
      let value = r.value || '';
      
      // CRITICAL FIX: If buffer exists (from asset_blob_storage), convert it to base64
      // buffer.toString() without encoding returns binary data with null bytes
      if (r.buffer && Buffer.isBuffer(r.buffer)) {
        if (r.asset_type === 'image') {
          // Convert binary PNG buffer to base64 string
          value = r.buffer.toString('base64');
        } else if (r.asset_type === 'json') {
          // For JSON, convert buffer to UTF-8 string
          value = r.buffer.toString('utf-8');
        } else {
          // For other types, use base64
          value = r.buffer.toString('base64');
        }
      }
      
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
      if (!reply.sent) return reply.send(result);
    } catch (e: any) {
      req.log?.warn({ err: e }, '[assets/batch] Error, returning empty');
      if (!reply.sent) {
        try { return reply.send({}); } catch (sendErr: any) { req.log?.error({ err: sendErr }, '[assets/batch] Failed to send'); }
      }
    }
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

  // Explicit OPTIONS for by-movement so preflight always gets CORS (no auth on OPTIONS)
  app.options('/assets/by-movement', async (req: any, reply: any) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id, x-goog-api-key, x-api-key');
    reply.header('Access-Control-Max-Age', '86400');
    return reply.status(204).send();
  });

  app.post('/assets/by-movement', { preHandler: authGuard }, async (req: any, reply: any) => {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assets.ts:376',message:'by-movement entry',data:{body:req.body},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(()=>{});
    // #endregion
    // CORS on every response path (success, error, and outer catch)
    const corsHeaders = () => {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Credentials', 'false');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id, x-goog-api-key, x-api-key');
    };
    corsHeaders();

    let body: { movementId: string; limit?: number };
    try {
      body = z.object({ movementId: z.string().min(1), limit: z.number().min(1).max(50).optional() }).parse(req.body || {});
    } catch (parseErr: any) {
      req.log?.warn({ err: parseErr }, '[by-movement] Validation failed');
      if (!reply.sent) {
        corsHeaders();
        reply.header('Content-Type', 'application/json');
        return reply.status(400).send({ error: parseErr?.message || 'Invalid request: movementId required' });
      }
      return;
    }

    try {
      // Cap limit aggressively to avoid Cloud Run response-size issues
      const requestedLimit = body?.limit ?? 40;
      const limit = Math.min(requestedLimit, 40);
      const originalMovementId = body.movementId;
      req.log.info(`[by-movement] Query for movementId: ${originalMovementId}, limit: ${limit}`);

      // Use a dedicated client with longer timeout to avoid "Query read timeout" when syncing many images
      const client = await pool.connect();
      let rows: any[];
      const queryParams = [originalMovementId, `ex:${originalMovementId}:%`, `meal:${originalMovementId}:%`, `ex_${originalMovementId}%`, `meal_${originalMovementId}%`, `${originalMovementId}%`, limit];
      const fullQuery = `SELECT a.key, 
                   CASE 
                     WHEN a.asset_type = 'image' THEN COALESCE(ENCODE(b.data, 'base64'), a.value)
                     ELSE a.value
                   END as value,
                   a.asset_type, a.status, a.created_at,
                   m.prompt, m.mode, m.source, m.created_by, m.created_at AS meta_created_at, m.movement_id,
                   m.translation_status, m.translation_error,
                   m.video_status, m.video_error,
                   m.step_index, m.persona
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
            LIMIT $7`;
      const fallbackQuery = `SELECT a.key, 
                   CASE 
                     WHEN a.asset_type = 'image' THEN COALESCE(ENCODE(b.data, 'base64'), a.value)
                     ELSE a.value
                   END as value,
                   a.asset_type, a.status, a.created_at,
                   m.prompt, m.mode, m.source, m.created_by, m.created_at AS meta_created_at, m.movement_id
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
            LIMIT $7`;
      // No meta table: match by key pattern only (works when cached_asset_meta missing or broken)
      const minimalQuery = `SELECT a.key,
            CASE WHEN a.asset_type = 'image' THEN COALESCE(ENCODE(b.data, 'base64'), a.value) ELSE a.value END as value,
            a.asset_type, a.status, a.created_at
            FROM cached_assets a
            LEFT JOIN asset_blob_storage b ON b.key = a.key
            WHERE a.key LIKE $1 OR a.key LIKE $2 OR a.key LIKE $3 OR a.key LIKE $4 OR a.key LIKE $5
            ORDER BY a.created_at DESC
            LIMIT $6`;
      const minimalParams = [`ex:${originalMovementId}:%`, `meal:${originalMovementId}:%`, `ex_${originalMovementId}%`, `meal_${originalMovementId}%`, `${originalMovementId}%`, limit];
      const normalizeRow = (r: any) => ({
        ...r,
        prompt: r.prompt ?? null,
        mode: r.mode ?? null,
        source: r.source ?? null,
        created_by: r.created_by ?? null,
        meta_created_at: r.meta_created_at ?? null,
        movement_id: r.movement_id ?? originalMovementId,
        translation_status: r.translation_status ?? null,
        translation_error: r.translation_error ?? null,
        video_status: r.video_status ?? null,
        video_error: r.video_error ?? null,
        step_index: r.step_index ?? null,
        persona: r.persona ?? null,
        text_context: r.text_context ?? null,
        text_context_simple: r.text_context_simple ?? null
      });
      try {
        await client.query(`SET statement_timeout = '120000'`);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assets.ts:465',message:'before fullQuery',data:{movementId:originalMovementId,queryParamsCount:queryParams.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
        // #endregion
        const res = await client.query(fullQuery, queryParams);
        rows = res.rows;
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assets.ts:468',message:'fullQuery success',data:{rowsCount:rows.length,firstKey:rows[0]?.key},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
        // #endregion
      } catch (queryErr: any) {
        const code = queryErr?.code;
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assets.ts:471',message:'fullQuery error',data:{code,msg:queryErr?.message,detail:queryErr?.detail},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(()=>{});
        // #endregion
        req.log.warn({ err: queryErr, code }, '[by-movement] Full query failed, trying fallbacks');
        try {
          const fallbackRes = await client.query(fallbackQuery, queryParams);
          rows = fallbackRes.rows.map((r: any) => normalizeRow({ ...r, translation_status: null, translation_error: null, video_status: null, video_error: null, step_index: null, persona: null }));
        } catch (fallbackErr: any) {
          req.log.warn({ err: fallbackErr }, '[by-movement] Fallback query failed, using minimal (key pattern only)');
          try {
            const minRes = await client.query(minimalQuery, minimalParams);
            rows = minRes.rows.map((r: any) => normalizeRow(r));
          } catch (minErr: any) {
            req.log.warn({ err: minErr }, '[by-movement] Minimal query failed, returning empty');
            rows = [];
          }
        }
      } finally {
        client.release();
      }

      req.log.info(`[by-movement] Found ${rows.length} rows for ${originalMovementId}`);
      const processedRows = rows.map((row: any) => {
        // CRITICAL: Ensure image values are always valid base64 data URIs
        if (row.asset_type === 'image' && row.value) {
          if (typeof row.value === 'string') {
            // If already a data URI, validate and clean it
            if (row.value.startsWith('data:image')) {
              const match = row.value.match(/data:image\/[^;]+;base64,(.+)/s);
              if (match && match[1]) {
                const base64Data = match[1].replace(/[\s\r\n\t]/g, '');
                if (/^[A-Za-z0-9+/=]+$/.test(base64Data) && base64Data.length > 100) {
                  row.value = `data:image/png;base64,${base64Data}`;
                } else {
                  req.log.warn(`[by-movement] Invalid base64 in data URI for ${row.key}, skipping`);
                  row.value = null;
                }
              }
            } else {
              // Raw base64 string - clean and validate
              const cleaned = row.value.replace(/[\s\r\n\t]/g, '');
              if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 100) {
                row.value = `data:image/png;base64,${cleaned}`;
              } else {
                req.log.warn(`[by-movement] Invalid base64 for ${row.key}, skipping`);
                row.value = null;
              }
            }
          } else if (Buffer.isBuffer(row.value)) {
            // Binary buffer - convert to base64
            row.value = `data:image/png;base64,${row.value.toString('base64')}`;
          } else {
            req.log.warn(`[by-movement] Unexpected image value type for ${row.key}: ${typeof row.value}`);
            row.value = null;
          }
        }
        // text_context/text_context_simple exist only after migration 046; default for same response shape
        if (row.text_context === undefined) row.text_context = null;
        if (row.text_context_simple === undefined) row.text_context_simple = null;
        return row;
      });
      return processedRows;
    } catch (e: any) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assets.ts:537',message:'by-movement outer catch',data:{msg:e?.message,stack:e?.stack,code:e?.code},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2'})}).catch(()=>{});
      // #endregion
      req.log.error({ err: e }, '[by-movement] Error');
      if (!reply.sent) {
        try {
          corsHeaders();
          reply.header('Content-Type', 'application/json');
          return reply.status(200).send([]);
        } catch (sendErr: any) {
          req.log?.error({ err: sendErr }, '[by-movement] Failed to send error response');
        }
      }
    }
  });
}

// Force rebuild 2026-01-19
