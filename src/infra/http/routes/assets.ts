import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { canonicalService } from '../../../application/services/canonicalService.js';

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

      // 1. Search for asset
      let { rows } = await pool.query(
        `SELECT value, asset_type, status FROM cached_assets WHERE key=$1 LIMIT 1`,
        [decodedKey]
      );

      // 1.1 Meta-Fallback: If _meta requested but not found, try to resolve to group-level meta
      if (rows.length === 0 && decodedKey.endsWith('_meta')) {
        // IMPROVED: Strip any known suffixes recursively
        const groupMetaKey = decodedKey.split('_meta')[0]
          .replace(/_(atlas|nova|mannequin)$/, '')
          .replace(/_(main|step_\d+|video_.*)$/, '')
          .replace(/_(atlas|nova|mannequin)$/, '') // Repeat to catch double suffixes
          + '_meta';

        if (groupMetaKey !== decodedKey) {
          req.log.info(`[Proxy] Meta-Fallback: ${decodedKey} -> ${groupMetaKey}`);
          const metaFallback = await pool.query(
            `SELECT value, asset_type, status FROM cached_assets WHERE key=$1 LIMIT 1`,
            [groupMetaKey]
          );
          if (metaFallback.rows.length > 0) rows = metaFallback.rows;
        }
      }

      // 1.2 Return immediately if found and active
      if (rows.length > 0) {
        let { value, asset_type, status } = rows[0];

        // Enrichment: If it's an image, try to fetch associated instructions for Admin UI
        let textContext = '';
        let textContextSimple = '';

        if (asset_type === 'image' && (status === 'active' || status === 'auto' || status === 'generating')) {
          const groupMetaKey = decodedKey
            .replace(/_(atlas|nova|mannequin)_(main|step_\d+|video_.*)$/, '_meta')
            .replace(/_(main|step_\d+|video_.*)$/, '_meta');

          const metaRes = await pool.query(`SELECT value FROM cached_assets WHERE key=$1 LIMIT 1`, [groupMetaKey]);
          if (metaRes.rows.length > 0) {
            try {
              const meta = JSON.parse(metaRes.rows[0].value);
              const stepMatch = decodedKey.match(/step_(\d+)$/);
              if (stepMatch) {
                const stepNum = parseInt(stepMatch[1]);
                const instrs = meta.instructions || meta.steps || [];
                if (instrs[stepNum - 1]) {
                  const instr = instrs[stepNum - 1];
                  textContext = instr.detailed || instr.instruction || instr.description || '';
                  textContextSimple = instr.simple || instr.cue || '';
                }
              } else {
                textContext = meta.description || meta.recipeDescription || meta.textContext || '';
                textContextSimple = meta.summary || meta.textContextSimple || '';
              }
            } catch (e) { /* ignore parse errors */ }
          }
        }

        if (status === 'active' || status === 'auto' || status === 'generating') {
          return { value, assetType: asset_type, status, textContext, textContextSimple };
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

        // ULTRA FUZZY SEARCH
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

          // Trigger generation in background
          const { BatchAssetService } = await import('../../../services/BatchAssetService.js');
          BatchAssetService.generateGroupAssets({
            groupId: id,
            groupName: name,
            groupType: isExercise ? 'exercise' : 'meal',
            targetStatus: 'auto'
          }).catch((err: any) => req.log.error(`[SmartProxy] Background gen failed for ${name}:`, err));

          const isMeta = decodedKey.endsWith('_meta');
          return {
            value: isMeta ? {} : '',
            assetType: isMeta ? 'json' : 'image',
            status: 'generating'
          };
        } else {
          req.log.warn(`[Proxy] Discovery FAILED: No match in ${tableName} for ${movementSlug}`);
        }
      }

      return reply.status(404).send({ error: 'Asset not found' });
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

    let movementId = body.movementId;

    // Resolve alias to canonical ID if possible
    try {
      const isMeal = movementId.startsWith('meal_');
      const isExercise = movementId.startsWith('movement_');
      const type = isMeal ? 'meal' : (isExercise ? 'exercise' : 'meal'); // Default to meal if uncertain

      const cleanName = movementId.replace(/^(meal_|movement_)/, '').replace(/_/g, ' ');
      const canonical = await canonicalService.getCanonicalId(cleanName, type);
      if (canonical && canonical.canonicalId) {
        movementId = canonical.canonicalId;
      }
    } catch (e) {
      req.log.warn(`[Assets] Alias resolution failed for ${movementId}, falling back to literal key`);
    }

    // FIX: Search for keys with proper prefixes (ex_ for exercises, meal_ for meals)
    // The keys are stored as ex_${movementId}_atlas_main, meal_${movementId}_step_1, etc.
    const { rows } = await pool.query(
      `SELECT a.key, a.value, a.asset_type, a.status, a.created_at,
               m.prompt, m.mode, m.source, m.created_by, m.created_at AS meta_created_at, m.movement_id,
               m.translation_status, m.translation_error,
               m.video_status, m.video_error,
               m.text_context, m.text_context_simple, m.step_index, m.persona
        FROM cached_assets a
        LEFT JOIN cached_asset_meta m ON m.key = a.key
        WHERE m.movement_id = $1 
           OR a.key LIKE $2 
           OR a.key LIKE $3
           OR a.key LIKE $4
        ORDER BY a.created_at DESC
        LIMIT $5`,
      [movementId, `ex_${movementId}%`, `meal_${movementId}%`, `${movementId}%`, limit]
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

// Force rebuild 2026-01-19
