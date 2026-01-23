import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminGuard, authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
// Native fetch used
import { env } from '../../../config/env.js';
import { uploadToYouTube } from '../../../services/youtubeService.js';
import bcrypt from 'bcryptjs';
import { normalizeToMovementId } from '../../../application/services/normalization.js';
import { UnifiedAssetService } from '../../../application/services/UnifiedAssetService.js';
import { AssetOrchestrator } from '../../../application/services/AssetOrchestrator.js';
import { AssetRepository } from '../../db/repositories/AssetRepository.js';
import { MovementRepository } from '../../db/repositories/MovementRepository.js';
import { jobManager } from '../../../application/GenerationJobManager.js';
import { UnifiedKey } from '../../../domain/UnifiedKey.js';

const assetGenSchema = z.object({
  mode: z.enum(['image', 'video', 'json']).default('image'),
  prompt: z.string().min(1),
  key: z.string().optional(),
  status: z.enum(['active', 'draft', 'auto']).default('active'),
  movementId: z.string().optional(),
  imageInput: z.string().optional()
});

const seedSchema = z.object({
  type: z.enum(['trainers', 'posts', 'challenges'])
});

const roleSchema = z.object({
  targetUserId: z.string(),
  newRole: z.enum(['admin', 'user', 'moderator', 'banned'])
});


export async function adminRoutes(app: FastifyInstance) {
  // Batch Trigger
  app.post('/admin/batch/run', { preHandler: adminGuard }, async (req: any, reply: any) => {
    // Legacy - disabled in reborn
    return reply.status(410).send({ error: 'Legacy Batch run is permanently disabled. Use /admin/generation/batch' });
  });

  // NEW: Group Generation Trigger (Server-Side)
  app.post('/admin/batch/generate-group', { preHandler: adminGuard }, async (req: any, reply: any) => {
    // Delegating to modern batch
    return reply.status(410).send({ error: 'Use /admin/generation/batch' });
  });

  // NEW: Publish & Translate Endpoint
  app.post('/admin/publish', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const body = z.object({
      groupId: z.string(),
      groupName: z.string(),
      groupType: z.enum(['exercise', 'meal'])
    }).parse(req.body);

    const { TranslationService } = await import('../../../services/TranslationService.js');

    // Fire and forget (Async)
    TranslationService.publishAndTranslate(body.groupId, body.groupName, body.groupType)
      .catch(err => req.log.error({ msg: "Translation failed", err }));

    return reply.send({ success: true, message: "Publishing started. Translations running in background." });
  });

  // Asset generation proxy (server-side Gemini key)
  app.post('/admin/generate-asset', { preHandler: adminGuard }, async (req: any, reply: any) => {
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    const body = assetGenSchema.parse(req.body || {});
    const { mode, prompt, key, status, movementId, imageInput } = body;

    let value: string | null = null;
    try {
      // Helper to prepare parts
      const parts: any[] = [];
      if (imageInput) {
        // Strip prefix if present (data:image/png;base64,)
        const base64Data = imageInput.replace(/^data:image\/\w+;base64,/, "");
        parts.push({
          inlineData: {
            mimeType: "image/png",
            data: base64Data
          }
        });
      }
      parts.push({ text: prompt });

      if (mode === 'image') {
        const model = 'gemini-2.5-flash-image';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ['IMAGE']
            }
          })
        });

        if (!res.ok) {
          const errorText = await res.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {
            errorData = null;
          }

          // Check for rate limit error
          if (res.status === 429 || errorData?.error?.message?.includes('quota')) {
            const retryDelay = errorData?.error?.details?.find((d: any) => d['@type']?.includes('RetryInfo'))?.retryDelay;
            const waitTime = retryDelay ? parseInt(retryDelay) : 60;
            throw new Error(`Rate limit exceeded. Please wait ${waitTime} seconds and try again.`);
          }

          const isProduction = process.env.NODE_ENV === 'production';
          req.log?.error({ error: errorText, status: res.status });
          throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
        }

        const data: any = await res.json();
        const resParts = data?.candidates?.[0]?.content?.parts || [];
        const inline = resParts.find((p: any) => p.inlineData?.data);
        if (inline?.inlineData?.data) {
          value = `data:image/png;base64,${inline.inlineData.data}`;
        }
      } else if (mode === 'json') {
        const model = 'models/gemini-1.5-flash';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }] // JSON usually text-only prompt
          })
        });

        if (!res.ok) {
          const errorText = await res.text();
          const isProduction = process.env.NODE_ENV === 'production';
          req.log?.error({ error: errorText, status: res.status });
          throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
        }

        const data: any = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // Gemini often wraps JSON in backticks
        value = text;
      } else {
        // Attempt Real Veo Generation
        // Note: 'veo-001-preview' is the model name for private preview
        const model = 'models/veo-001-preview';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts }] // Send image to Veo if provided
          })
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Veo API error (${res.status}): ${errorText}`);
        }

        const data: any = await res.json();
        const videoUri = data?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri;

        if (!videoUri) {
          throw new Error(`Veo API returned no video URI. Response: ${JSON.stringify(data)}`);
        }

        value = videoUri;
      }

      if (value && key) {
        const uKey = UnifiedKey.parse(key);
        const buffer = Buffer.from(value.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        const assetType = mode === 'json' ? 'json' : mode as any;
        const targetStatus = status === 'draft' ? 'generating' : (status === 'auto' ? 'active' : status as any);

        await AssetRepository.save(uKey, {
          buffer,
          status: targetStatus,
          type: assetType,
          metadata: {
            prompt,
            mode,
            source: 'admin_generate_asset',
            created_by: (req as any).user?.userId || null,
            movement_id: movementId || null
          }
        });

        // Let Orchestrator finish "Unicorn" details if needed
        await AssetOrchestrator.generateAssetForKey(key, true);
        const updated = await AssetRepository.findByKey(key);
        if (updated && updated.buffer) {
          value = `data:image/png;base64,${updated.buffer.toString('base64')}`;
        }
      }

      return reply.send({ value });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'admin generate asset failed', e, requestId: (req as any).requestId });

      // Always show rate limit errors to the user
      const errorMessage = e.message || 'generation failed';
      const isRateLimitError = errorMessage.includes('Rate limit') || errorMessage.includes('quota');

      return reply.status(500).send({
        error: (isRateLimitError || !isProduction) ? errorMessage : 'Asset generation service unavailable'
      });
    }
  });

  const uploadSchema = z.object({
    videoUrl: z.string(),
    title: z.string(),
    description: z.string(),
    privacyStatus: z.enum(['private', 'unlisted', 'public']).optional()
  });

  app.post('/admin/upload-video', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const body = uploadSchema.parse(req.body);
      const result = await uploadToYouTube(body);
      return reply.send(result);
    } catch (e: any) {
      req.log.error({ error: 'youtube upload failed', e });
      return reply.status(500).send({ error: e.message });
    }
  });



  // Simple seed stubs
  app.post('/admin/seed', { preHandler: adminGuard }, async (req: any, reply: any) => {
    seedSchema.parse(req.body || {});
    return reply.send({ success: true, message: "Seed endpoint initialized" });
  });

  // Get system blueprints
  // Get system blueprints
  app.get('/admin/blueprints', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const asset = await AssetRepository.findByKey('system_blueprints');
      if (asset && asset.value) {
        return JSON.parse(asset.value);
      }
    } catch (e: any) {
      req.log.error(e);
    }

    return {
      appName: 'Vitality AI',
      guidelines: {
        styleExerciseImage: "Cinematic fitness photography. High contrast, dramatic lighting, professional gym environment, 8k resolution, highly detailed. Realistic skin textures and sweat. No text.",
        styleMealImage: "Hyperrealistic food photography. 8k resolution, highly detailed, delicious presentation, soft studio lighting, shallow depth of field. CRITICAL: NO TEXT, NO CALORIE LABELS, NO NUTRITION INFO, NO OVERLAYS.",
        styleExerciseVideo: "Cinematic 4k fitness shot, dark gym, moody lighting, slow motion execution.",
        style3DAnatomyVideo: "3D anatomical render of [Subject]. Transparent biological skin, glowing emerald green muscle highlights on [Target Muscles]. Neutral studio background. Seamless loop motion. 4k resolution, high frame rate.",
        toneCoach: "Motivational, tough but fair, safety-focused.",
        vitalityAvatarDescription: "Athletic Mannequin figure. Faceless, featureless face. Bald head. Neutral metallic grey skin tone. Wearing solid Emerald Green athletic shorts and Slate Grey top. No text, no logos.",
        themes: []
      }
    };
  });

  app.post('/admin/blueprints', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      await AssetRepository.save('system_blueprints', {
        value: JSON.stringify(req.body),
        status: 'active',
        type: 'json'
      });
      return { success: true };
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: "Failed to save blueprints" });
    }
  });

  // BEHAVIORAL CONFIG
  app.get('/admin/behavioral-config', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const asset = await AssetRepository.findByKey('behavioral_config');
      if (asset && asset.value) {
        return JSON.parse(asset.value);
      }
    } catch (e: any) {
      req.log.warn(e);
    }

    // Defaults
    return {
      critChance: 0.1,
      nudgeMessages: ["Keep it up!", "Don't break the chain!"],
      futureMessages: [],
      flashQuests: [],
      streakFreezeBaseCost: 100,
      streakFreezeMultiplier: 1.5,
      persona: 'stoic'
    };
  });

  app.post('/admin/behavioral-config', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      await AssetRepository.save('behavioral_config', {
        value: JSON.stringify(req.body),
        status: 'active',
        type: 'json'
      });
      return { success: true };
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: "Failed to save config" });
    }
  });

  // ITEMS
  app.get('/admin/items', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const assets = await AssetRepository.findByType('game_item');
      return assets.map(a => JSON.parse(a.value));
    } catch (e: any) {
      return [];
    }
  });

  app.post('/admin/items', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const body = req.body as any;
    try {
      const id = body.id || `item_${Date.now()}`;
      await AssetRepository.save(id, {
        value: JSON.stringify(body),
        status: 'active',
        type: 'json'
      });
      return { success: true, id };
    } catch (e: any) {
      return reply.status(500).send({ error: "Failed to create item" });
    }
  });

  // Note: /admin/users route is defined later with search functionality

  // User role update
  app.post('/admin/users/role', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const body = roleSchema.parse(req.body || {});
    await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2`,
      [body.newRole, body.targetUserId]
    );
    return reply.send({ success: true });
  });

  // Get all movements (exercises and meals) from database
  app.get('/admin/movements', { preHandler: adminGuard }, async (req: any) => {
    try {
      const { exercises: exRows, meals: mealRows } = await MovementRepository.getMovementManifest();

      const exercises = exRows.map((ex: any) => {
        const movementId = normalizeToMovementId(ex.name);
        return {
          id: movementId,
          name: ex.name,
          movementId,
          metadata: ex.metadata
        };
      }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      const meals = mealRows.map((m: any) => {
        const movementId = normalizeToMovementId(m.name);
        return {
          id: movementId,
          name: m.name,
          movementId,
          instructions: m.instructions
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      return { exercises, meals };
    } catch (e: any) {
      req.log?.error({ error: 'admin movements fetch failed', message: e.message });
      return { exercises: [], meals: [] };
    }
  });

  // Batch Check Asset Existence
  app.post('/admin/assets/batch-check', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const { keys } = req.body as { keys: string[] };
    if (!keys || keys.length === 0) return reply.send([]);

    try {
      const res = await pool.query(
        `SELECT key FROM cached_assets WHERE key = ANY($1)`,
        [keys]
      );
      return reply.send(res.rows.map(r => r.key));
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: "Batch check failed" });
    }
  });

  // NEW: Get Recent User Content for Admin Review
  app.get('/admin/assets/recent', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      // Fetch distinct movement_ids, sorted globally by most recent generation
      const res = await pool.query(
        `SELECT * FROM (
          SELECT DISTINCT ON (movement_id) 
            movement_id, 
            source, 
            original_name,
            language,
            MAX(created_at) OVER (PARTITION BY movement_id) as latest_gen
          FROM cached_asset_meta 
          WHERE movement_id IS NOT NULL 
          ORDER BY movement_id, created_at DESC
        ) sub
        ORDER BY latest_gen DESC
        LIMIT 500`
      );
      return res.rows;
    } catch (e: any) {
      req.log.error(e);
      return [];
    }
  });

  // Batch Scan (Regex/Prefix Match for messy keys) including VALUES
  app.post('/admin/assets/scan', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const { prefixes } = req.body as { prefixes: string[] };
    if (!prefixes || prefixes.length === 0) return reply.send([]);

    try {
      // Construct LIKE patterns: prefix%
      const patterns = prefixes.map(p => `${p}%`);
      console.log("[AdminScan] LIKE Patterns:", patterns);

      const res = await pool.query(
        `SELECT a.key, a.asset_type, a.status,
                m.translation_status, m.video_status, m.translation_error, m.video_error,
                m.original_name, m.language
         FROM cached_assets a
         LEFT JOIN cached_asset_meta m ON m.key = a.key
         WHERE a.key LIKE ANY($1) OR m.original_name LIKE ANY($1)
         LIMIT 2000`,
        [patterns]
      );
      return reply.send(res.rows);
    } catch (e: any) {
      console.error("[AdminScan] Failed:", e.message);
      req.log.error(e);
      return reply.status(500).send({ error: `Scan failed: ${e.message}` });
    }
  });

  // ================== UNIFIED ASSET GENERATION ROUTES ==================



  /**
   * GET /admin/generation/stream/:jobId
   * Real-time SSE stream for generation progress
   */
  app.get('/admin/generation/stream/:jobId', { preHandler: adminGuard }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const onUpdate = (progress: any) => {
      reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);
    };

    // Send initial state
    const current = jobManager.getJob(jobId);
    if (current) onUpdate(current);

    jobManager.on(`job:${jobId}`, onUpdate);

    req.raw.on('close', () => {
      jobManager.off(`job:${jobId}`, onUpdate);
    });
  });

  /**
   * GET /admin/generation/status
   * Get asset status for all exercises and meals using Repositories
   */
  app.get('/admin/generation/status', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const { type = 'both', status: statusFilter = 'all' } = req.query as { type?: string, status?: string };
      const items: any[] = [];

      if (type === 'ex' || type === 'both') {
        const exercises = await MovementRepository.findAllExercises();
        for (const ex of exercises) {
          const assets = await AssetRepository.findByMovement(ex.id);

          let itemStatus: 'empty' | 'partial' | 'complete' | 'failed' = 'empty';
          const totalExpected = 13; // ex: 1 meta (none) + 1 main (atlas) + 6 steps (atlas) + 1 main (nova) + 6 steps (nova) - wait, meta index 0, main index 0...
          // For reborn, we use UnifiedAssetService.getManifest to be sure.

          const complete = assets.filter(a => a.status === 'active').length;
          const failed = assets.filter(a => a.status === 'failed').length;

          if (complete > 0) {
            itemStatus = complete >= 13 ? 'complete' : 'partial';
          } else if (failed > 0) {
            itemStatus = 'failed';
          }

          if (statusFilter === 'all' || statusFilter === itemStatus) {
            items.push({
              type: 'ex', id: ex.id, name: ex.name, status: itemStatus, assets: {
                total: 13,
                complete,
                failed,
                empty: 13 - complete - failed
              }
            });
          }
        }
      }

      if (type === 'meal' || type === 'both') {
        const meals = await MovementRepository.findAllMeals();
        for (const meal of meals) {
          const assets = await AssetRepository.findByMovement(meal.id);

          let itemStatus: 'empty' | 'partial' | 'complete' | 'failed' = 'empty';
          const totalExpected = 8; // meal: 1 meta + 1 main + 6 steps

          const complete = assets.filter(a => a.status === 'active').length;
          const failed = assets.filter(a => a.status === 'failed').length;

          if (complete > 0) {
            itemStatus = complete >= 8 ? 'complete' : 'partial';
          } else if (failed > 0) {
            itemStatus = 'failed';
          }

          if (statusFilter === 'all' || statusFilter === itemStatus) {
            items.push({
              type: 'meal', id: meal.id, name: meal.name, status: itemStatus, assets: {
                total: 8,
                complete,
                failed,
                empty: 8 - complete - failed
              }
            });
          }
        }
      }

      return reply.send({ items, total: items.length });
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: e.message });
    }
  });

  /**
   * GET /admin/generation/progress/:jobId
   * Polling endpoint for job progress
   */
  app.get('/admin/generation/progress/:jobId', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const { jobId } = req.params as { jobId: string };
    const job = jobManager.getJob(jobId);
    if (!job) return reply.status(404).send({ error: 'Job not found' });

    // Map internal skipped to external format for UI if needed or just return as is
    return reply.send({
      id: job.jobId,
      status: job.status === 'completed' ? 'complete' : (job.status === 'failed' ? 'failed' : 'running'),
      total: job.total,
      completed: job.completed,
      failed: job.failed,
      currentItem: job.currentItem || ''
    });
  });

  /**
   * POST /admin/generation/batch
   * Start batch asset generation
   */
  app.post('/admin/generation/batch', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const { mode, type, ids, count = 10 } = req.body as any;
      const jobId = `job_${Date.now()}`;

      let itemsToProcess: Array<{ type: 'ex' | 'meal', id: string, name: string }> = [];

      if (mode === 'selected' && Array.isArray(ids)) {
        for (const item of ids) {
          const movement = item.type === 'ex'
            ? await MovementRepository.findExerciseById(item.id)
            : await MovementRepository.findMealById(item.id);
          if (movement) {
            itemsToProcess.push({ type: item.type, id: movement.id, name: movement.name });
          }
        }
      } else if (mode === 'next') {
        // Fetch missing items based on type filter
        const types = type ? [type] : ['ex', 'meal'];
        for (const t of types) {
          const movements = t === 'ex' ? await MovementRepository.findAllExercises() : await MovementRepository.findAllMeals();
          for (const m of movements) {
            const assets = await AssetRepository.findByMovement(m.id);
            if (assets.length < (t === 'ex' ? 13 : 8)) {
              itemsToProcess.push({ type: t as any, id: m.id, name: m.name });
            }
            if (itemsToProcess.length >= count) break;
          }
          if (itemsToProcess.length >= count) break;
        }
      }

      if (itemsToProcess.length === 0) {
        return reply.status(400).send({ error: 'No items found for generation' });
      }

      // Calculate total steps across all manifests
      let totalSteps = 0;
      const tasks: string[] = [];
      for (const item of itemsToProcess) {
        const manifest = await UnifiedAssetService.getManifest(item.type, item.id, item.name);
        tasks.push(...manifest);
        totalSteps += manifest.length;
      }

      jobManager.createJob(jobId, totalSteps);

      // Async process
      (async () => {
        for (const key of tasks) {
          try {
            const currentJob = jobManager.getJob(jobId);
            if (!currentJob) break;

            jobManager.updateProgress(jobId, { currentItem: key });
            const result = await AssetOrchestrator.generateAssetForKey(key);

            if (result === 'SUCCESS' || result === 'EXISTS') {
              jobManager.updateProgress(jobId, { completed: (jobManager.getJob(jobId)?.completed || 0) + 1 });
            } else if (result === 'FAILED') {
              jobManager.updateProgress(jobId, { failed: (jobManager.getJob(jobId)?.failed || 0) + 1 });
            } else {
              jobManager.updateProgress(jobId, { skipped: (jobManager.getJob(jobId)?.skipped || 0) + 1 });
            }
          } catch (e: any) {
            jobManager.updateProgress(jobId, { failed: (jobManager.getJob(jobId)?.failed || 0) + 1 });
          }
        }
      })().catch(err => req.log.error({ msg: "Batch processing crash", err }));

      return reply.send({ jobId, message: 'Batch generation started' });
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: e.message });
    }
  });

  // ================== ADMIN USER MANAGEMENT ==================

  // Admin: Reset user password
  app.post('/admin/users/:userId/reset-password', { preHandler: [authGuard, adminGuard] }, async (req: any, reply: any) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({
      newPassword: z.string().min(8).regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
        'Password must contain uppercase, lowercase, and number'
      )
    }).parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user exists
      const userCheck = await client.query('SELECT id, email FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      // Hash new password
      const hash = await bcrypt.hash(body.newPassword, 10);

      // Update password
      await client.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [hash, userId]
      );

      await client.query('COMMIT');

      req.log.info({
        type: 'admin_password_reset',
        adminId: (req as any).user.userId,
        targetUserId: userId,
        targetEmail: userCheck.rows[0].email
      });

      return reply.send({ success: true, message: 'Password reset successfully' });
    } catch (e: any) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // Admin: Update user profile
  app.patch('/admin/users/:userId/profile', { preHandler: [authGuard, adminGuard] }, async (req: any, reply: any) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({
      email: z.string().email().optional(),
      username: z.string().optional(),
      role: z.enum(['admin', 'moderator', 'user', 'banned']).optional(),
      profileData: z.record(z.any()).optional()
    }).parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user exists
      const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      // Update users table if email/username/role provided
      if (body.email || body.username || body.role) {
        const updates: string[] = [];
        const values: any[] = [];
        let idx = 1;

        if (body.email) {
          updates.push(`email = $${idx++}`);
          values.push(body.email.toLowerCase().trim());
        }
        if (body.username) {
          updates.push(`username = $${idx++}`);
          values.push(body.username.toLowerCase().trim());
        }
        if (body.role) {
          updates.push(`role = $${idx++}`);
          values.push(body.role);
        }
        updates.push(`updated_at = NOW()`);
        values.push(userId);

        await client.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
          values
        );
      }

      // Update profile_data if provided
      if (body.profileData) {
        await client.query(
          `UPDATE user_profiles 
           SET profile_data = profile_data || $1::jsonb, updated_at = NOW() 
           WHERE user_id = $2`,
          [JSON.stringify(body.profileData), userId]
        );
      }

      await client.query('COMMIT');

      req.log.info({
        type: 'admin_profile_update',
        adminId: (req as any).user.userId,
        targetUserId: userId,
        updates: Object.keys(body)
      });

      return reply.send({ success: true, message: 'Profile updated successfully' });
    } catch (e: any) {
      await client.query('ROLLBACK');
      if (e.message?.includes('duplicate key') || e.message?.includes('unique constraint')) {
        return reply.status(409).send({ error: 'Email or username already exists' });
      }
      throw e;
    } finally {
      client.release();
    }
  });

  // Admin: Get all users with basic info
  app.get('/admin/users', { preHandler: [authGuard, adminGuard] }, async (req: any, reply: any) => {
    const { limit = 50, offset = 0, search } = req.query as { limit?: number; offset?: number; search?: string };

    let query = `
      SELECT 
        u.id as user_id, 
        u.email, 
        u.username,
        u.role,
        u.created_at,
        p.profile_data
      FROM users u
      LEFT JOIN user_profiles p ON u.id = p.user_id
    `;
    const values: any[] = [];

    if (search) {
      query += ` WHERE u.email ILIKE $1 OR u.username ILIKE $1`;
      values.push(`%${search}%`);
    }

    query += ` ORDER BY u.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    values.push(limit, offset);

    const res = await pool.query(query, values);

    return {
      users: res.rows.map(row => ({
        user_id: row.user_id,
        email: row.email,
        username: row.username,
        role: row.role || 'user',
        created_at: row.created_at,
        profile: row.profile_data
      })),
      count: res.rows.length
    };
  });
}

