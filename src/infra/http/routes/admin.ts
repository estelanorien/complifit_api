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
import { AssetPromptService } from '../../../application/services/assetPromptService.js';

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
        const model = 'models/gemini-2.5-flash-image';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

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
        // Video generation runs only in the backend (Veo via Gemini API; no Vertex AI).
        // Frontend must use this endpoint; no client-side Veo or API key.
        // Uses predictLongRunning + poll; see https://ai.google.dev/gemini-api/docs/video
        const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
        const modelsToTry = ['models/veo-3.1-generate-preview', 'models/veo-3.1-fast-generate-preview', 'models/veo-3.0-generate-001'];
        let lastError: Error | null = null;
        let videoUri: string | null = null;

        console.log(`[Admin] Starting video generation for mode=${mode}, key=${key}`);

        for (const model of modelsToTry) {
          try {
            const startEndpoint = `${baseUrl}/${model}:predictLongRunning`;
            console.log(`[Admin] Trying Veo model: ${model}`);

            const startRes = await fetch(startEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': env.geminiApiKey
              },
              body: JSON.stringify({
                instances: [{ prompt: prompt }],
                parameters: { aspectRatio: '16:9' }
              })
            });

            if (!startRes.ok) {
              const errorText = await startRes.text();
              console.error(`[Admin] Veo start error (${model}): ${startRes.status} - ${errorText.substring(0, 200)}`);
              if (startRes.status === 404) {
                lastError = new Error(`Model ${model} not found`);
                continue;
              }
              throw new Error(`Veo API error (${startRes.status}): ${errorText}`);
            }

            const startData: any = await startRes.json();
            let opName = startData?.name;
            if (!opName) {
              lastError = new Error(`Veo start response missing operation name`);
              continue;
            }
            // Keep operation name as returned (e.g. "operations/..." or full URL)
            if (opName.startsWith('/')) opName = opName.slice(1);

            // Poll until done (max ~6 min per docs)
            const pollIntervalMs = 10000;
            const maxWaitMs = 360000;
            const pollUrl = opName.startsWith('http') ? opName : `${baseUrl}/${opName}`;
            let waited = 0;
            while (waited < maxWaitMs) {
              await new Promise((r) => setTimeout(r, pollIntervalMs));
              waited += pollIntervalMs;
              const pollRes = await fetch(pollUrl, {
                headers: { 'x-goog-api-key': env.geminiApiKey }
              });
              if (!pollRes.ok) {
                lastError = new Error(`Veo poll error: ${pollRes.status}`);
                break;
              }
              const pollData: any = await pollRes.json();
              if (pollData?.error) {
                lastError = new Error(pollData.error.message || JSON.stringify(pollData.error));
                break;
              }
              if (pollData?.done) {
                // LRO can put result in response or result
                const resp = pollData?.response ?? pollData?.result ?? {};
                const findUri = (o: any): string | null => {
                  if (!o || typeof o !== 'object') return null;
                  const u = o.uri ?? o.fileUri ?? o.url ?? o.videoUri;
                  if (typeof u === 'string' && (u.startsWith('http') || u.startsWith('https'))) return u;
                  if (Array.isArray(o)) { for (const i of o) { const v = findUri(i); if (v) return v; } return null; }
                  for (const k of Object.keys(o)) { const v = findUri(o[k]); if (v) return v; }
                  return null;
                };
                videoUri =
                  resp?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
                  resp?.generate_video_response?.generated_samples?.[0]?.video?.uri ||
                  resp?.generatedSamples?.[0]?.video?.uri ||
                  resp?.generated_samples?.[0]?.video?.uri ||
                  resp?.generatedVideos?.[0]?.video?.uri ||
                  resp?.generated_videos?.[0]?.video?.uri ||
                  findUri(resp?.generateVideoResponse ?? {}) ||
                  findUri(resp);
                if (videoUri) {
                  console.log(`[Admin] Video generated successfully with model ${model}`);
                  break;
                }
                const respPreview = JSON.stringify(resp).slice(0, 800);
                const topKeys = Object.keys(pollData).join(', ');
                console.error('[Admin] Veo done but no video URI. pollData keys:', topKeys, 'response preview:', respPreview);
                lastError = new Error(`Veo returned no video URI. Response keys: ${topKeys}. Preview: ${respPreview.slice(0, 200)}`);
                break;
              }
              console.log(`[Admin] Veo polling... (${waited / 1000}s)`);
            }

            if (videoUri) break;
            if (lastError && !lastError.message?.includes('404')) break;
          } catch (e: any) {
            console.error(`[Admin] Veo attempt failed (${model}):`, e.message);
            lastError = e;
            if (e.message?.includes('404')) continue;
            throw e;
          }
        }

        if (!videoUri) {
          const veoError = new Error(
            'Video generation uses Veo via the Gemini API (no Vertex AI required). ' +
            'Ensure your API key from aistudio.google.com has access to Veo (paid preview). ' +
            'Original error: ' + (lastError?.message || 'No Veo models available')
          );
          console.error('[Admin] Veo not available:', veoError.message);
          throw veoError;
        }

        value = videoUri;
      }

      if (value && key) {
        const uKey = UnifiedKey.parse(key);
        const assetType = mode === 'json' ? 'json' : mode as any;
        
        // Validate status
        const validStatuses = ['active', 'draft', 'generating', 'failed', 'rejected', 'auto'];
        const targetStatus = status === 'draft' ? 'generating' : (status === 'auto' ? 'active' : status as any);
        if (!validStatuses.includes(targetStatus)) {
          throw new Error(`Invalid status: ${targetStatus}. Must be one of: ${validStatuses.join(', ')}`);
        }

        // Handle different asset types correctly
        let buffer: Buffer | undefined = undefined;
        let storedValue = value;

        if (mode === 'image') {
          // Image: Extract base64 from data URI and store as buffer
          const base64Data = value.replace(/^data:image\/\w+;base64,/, "");
          buffer = Buffer.from(base64Data, 'base64');
          storedValue = value; // Keep full data URI in value field
        } else if (mode === 'video') {
          // Video: Store URI as string, no buffer
          storedValue = value; // Video URI string
          buffer = undefined; // No buffer for video URIs
        } else if (mode === 'json') {
          // JSON: Store as string, no buffer
          storedValue = value; // JSON text string
          buffer = undefined; // No buffer for JSON
        }

        await AssetRepository.save(uKey, {
          value: storedValue,
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

        // Only call Orchestrator for specific asset types that need enhancement
        // Skip for admin-generated assets to avoid double generation
        // Orchestrator is mainly for auto-generated "Unicorn" assets
        const shouldEnhance = key.includes('_meta') || key.includes('system_');
        if (shouldEnhance) {
          try {
            await AssetOrchestrator.generateAssetForKey(key, true);
            const updated = await AssetRepository.findByKey(key);
            if (updated && updated.buffer && mode === 'image') {
              value = `data:image/png;base64,${updated.buffer.toString('base64')}`;
            } else if (updated && updated.value && mode !== 'image') {
              value = updated.value;
            }
          } catch (orchestratorError: any) {
            req.log.warn({ error: 'Orchestrator enhancement failed', key, errorMessage: orchestratorError.message });
            // Continue with original value if orchestrator fails
          }
        }
      }

      return reply.send({ value });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'admin generate asset failed', e, requestId: (req as any).requestId });

      // Always show rate limit errors and video errors to the user (they need to know about Veo requirements)
      const errorMessage = e.message || 'generation failed';
      const isRateLimitError = errorMessage.includes('Rate limit') || errorMessage.includes('quota');
      const isVideoError = errorMessage.includes('Veo') || errorMessage.includes('video') || mode === 'video';

      // Show helpful errors for video generation (Veo requirements), rate limits, and in dev mode
      return reply.status(500).send({
        error: (isRateLimitError || isVideoError || !isProduction) ? errorMessage : 'Asset generation service unavailable'
      });
    }
  });

  // Video proxy: stream Veo/Google video URLs with API key so the UI can preview before publishing
  app.get('/admin/video-proxy', { preHandler: adminGuard }, async (req: any, reply: any) => {
    const uri = (req.query as { uri?: string }).uri;
    if (!uri || typeof uri !== 'string') return reply.status(400).send({ error: 'Missing uri query parameter' });
    try {
      const decoded = decodeURIComponent(uri);
      if (!decoded.startsWith('https://') || (!decoded.includes('generativelanguage.googleapis.com') && !decoded.includes('googleapis.com'))) {
        return reply.status(400).send({ error: 'Invalid video URI' });
      }
      const headers: Record<string, string> = {};
      if (decoded.includes('googleapis.com') && env.geminiApiKey) headers['x-goog-api-key'] = env.geminiApiKey;
      const res = await fetch(decoded, { headers });
      if (!res.ok) return reply.status(res.status).send({ error: `Upstream: ${res.statusText}` });
      const contentType = res.headers.get('content-type') || 'video/mp4';
      const buffer = Buffer.from(await res.arrayBuffer());
      reply.header('content-type', contentType);
      return reply.send(buffer);
    } catch (e: any) {
      req.log.error({ error: 'video-proxy failed', e });
      return reply.status(500).send({ error: e.message || 'Proxy failed' });
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

  // Voiceover videos: list localized_videos (only verification_status=passed shown for review)
  app.get('/admin/voiceover-videos', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const parentId = (req.query as any)?.parent_id;
      const languageCode = (req.query as any)?.language_code;
      const readyOnly = (req.query as any)?.ready_for_review === 'true';
      let query = `SELECT id, parent_id, language_code, youtube_url, gcs_path, status, verification_status, review_status, review_notes, reviewed_at, created_at
                   FROM localized_videos WHERE 1=1`;
      const params: any[] = [];
      let i = 1;
      if (parentId) { query += ` AND parent_id = $${i}`; params.push(parentId); i++; }
      if (languageCode) { query += ` AND language_code = $${i}`; params.push(languageCode); i++; }
      if (readyOnly) { query += ` AND verification_status = 'passed' AND review_status = 'ready_for_review'`; }
      query += ` ORDER BY parent_id, language_code`;
      const { rows } = await pool.query(query, params);
      return reply.send({ videos: rows });
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: e.message });
    }
  });

  app.patch('/admin/voiceover-videos/:id/review', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const id = (req.params as any).id;
      const body = z.object({ review_status: z.enum(['approved', 'revision_requested']), review_notes: z.string().optional() }).parse(req.body || {});
      await pool.query(
        `UPDATE localized_videos SET review_status = $1, review_notes = $2, reviewed_at = NOW() WHERE id = $3`,
        [body.review_status, body.review_notes ?? null, id]
      );
      return reply.send({ success: true });
    } catch (e: any) {
      req.log.error(e);
      return reply.status(500).send({ error: e.message });
    }
  });

  app.post('/admin/voiceover-videos/intervention', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const body = z.object({
        assetId: z.string(),
        intervention: z.enum(['replace_clips', 'reassemble_only', 'regenerate_voiceover', 'full_regenerate']),
        replaceShotTypes: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional()
      }).parse(req.body || {});
      const { videoQueue } = await import('../../../application/services/videoQueueService.js');
      if (body.intervention === 'full_regenerate') {
        await pool.query(`DELETE FROM video_source_clips WHERE parent_id = $1`, [body.assetId]);
        await pool.query(`DELETE FROM localized_videos WHERE parent_id = $1`, [body.assetId]);
      }
      await videoQueue.enqueue(body.assetId, null, { withVoiceover: true, languages: body.languages ?? ['en'] });
      return reply.send({ success: true, message: 'Intervention job enqueued' });
    } catch (e: any) {
      req.log.error(e);
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

  // FORCE REGENERATE META
  app.post('/admin/force-regenerate-meta', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const body = z.object({
        movementId: z.string(),
        type: z.enum(['exercise', 'meal']).optional(),
        stepCount: z.number().int().min(1).max(20).optional()
      }).parse(req.body);

      const { movementId, type, stepCount } = body;
      const normalizedId = normalizeToMovementId(movementId);
      
      // Determine type from movementId if not provided
      let assetType: 'exercise' | 'meal' = type || (normalizedId.startsWith('ex:') ? 'exercise' : 'meal');
      if (normalizedId.startsWith('meal:')) assetType = 'meal';
      if (normalizedId.startsWith('ex:')) assetType = 'exercise';

      // Derive meta key
      const metaKey = assetType === 'exercise' 
        ? `ex:${normalizedId.replace(/^ex:/, '')}:none:meta:0`
        : `meal:${normalizedId.replace(/^meal:/, '')}:none:meta:0`;

      // Delete existing meta (cached_asset_meta uses "key", not "asset_key")
      await pool.query(
        `DELETE FROM cached_assets WHERE key = $1`,
        [metaKey]
      );
      await pool.query(
        `DELETE FROM cached_asset_meta WHERE key = $1`,
        [metaKey]
      );

      const cleanName = normalizedId.replace(/^(ex|meal):/, '').replace(/_/g, ' ');
      
      // Generate new instructions (stepCount ensures we cover all execution steps)
      const instructions = await AssetPromptService.generateInstructions(cleanName, assetType, stepCount);
      
      // Save new meta
      const metaBuffer = Buffer.from(JSON.stringify(instructions), 'utf-8');
      await AssetRepository.save(UnifiedKey.parse(metaKey), {
        buffer: metaBuffer,
        type: 'json',
        status: 'active',
        metadata: {}
      });

      req.log.info({ movementId, metaKey, instructionsCount: instructions.instructions?.length || 0 }, 'Force regenerated meta');

      return reply.send({ 
        success: true, 
        message: `Meta regenerated for ${cleanName}`,
        instructionsCount: instructions.instructions?.length || 0
      });
    } catch (e: any) {
      req.log.error({ error: e, movementId: req.body?.movementId }, 'Force regenerate meta failed');
      return reply.status(500).send({ error: `Failed to regenerate meta: ${e.message}` });
    }
  });

  // WIPE ASSET IMAGES AND TEXT (for regeneration with better prompts) - supports both meals and exercises
  app.post('/admin/wipe-asset-images', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const body = z.object({
        movementId: z.string().optional(), // If provided, wipe only this asset group; otherwise wipe all
        type: z.enum(['meal', 'exercise']).optional(), // Filter by type if provided
        wipeText: z.boolean().optional().default(true) // Also wipe text instructions and translations
      }).parse(req.body);

      const { movementId, type, wipeText } = body;

      if (movementId) {
        // Wipe specific asset group (images + optionally text)
        const normalizedId = normalizeToMovementId(movementId);
        const prefix = type === 'exercise' ? 'ex' : (type === 'meal' ? 'meal' : null);
        
        let patterns: string[];
        if (prefix) {
          patterns = [
            `${prefix}:${normalizedId}:%`,
            `${prefix}_${normalizedId}%`
          ];
        } else {
          // Try both patterns if type not specified
          patterns = [
            `ex:${normalizedId}:%`,
            `meal:${normalizedId}:%`,
            `ex_${normalizedId}%`,
            `meal_${normalizedId}%`,
            `${normalizedId}%`
          ];
        }

        // 1. Delete images from cached_assets
        const { rowCount: imageCountRaw } = await pool.query(
          `DELETE FROM cached_assets 
           WHERE asset_type = 'image' 
           AND (${patterns.map((_, i) => `key LIKE $${i + 1}`).join(' OR ')})
           AND key NOT LIKE '%:meta:%'`,
          patterns
        );
        const imageCount = imageCountRaw ?? 0;

        // 2. Delete from blob storage
        await pool.query(
          `DELETE FROM asset_blob_storage 
           WHERE ${patterns.map((_, i) => `key LIKE $${i + 1}`).join(' OR ')}`,
          patterns
        );

        let textCount = 0;
        let translationJobCount = 0;
        let videoJobCount = 0;

        if (wipeText) {
          // 3. Clear text instructions from cached_asset_meta (use movement_id for more reliable matching)
          // First, get all keys for this movement to ensure we catch everything
          const { rows: metaRows } = await pool.query(
            `SELECT key, text_context, text_context_simple, movement_id FROM cached_asset_meta 
             WHERE movement_id = $1 
             OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})`,
            [normalizedId, ...patterns]
          );
          const metaKeys = metaRows.map((r: any) => r.key);
          const rowsWithText = metaRows.filter((r: any) => r.text_context || r.text_context_simple);
          
          req.log.info({ 
            movementId: normalizedId, 
            metaKeysFound: metaKeys.length, 
            rowsWithText: rowsWithText.length,
            metaKeysSample: metaKeys.slice(0, 5),
            rowsWithTextSample: rowsWithText.slice(0, 3).map((r: any) => ({ key: r.key, hasText: !!(r.text_context || r.text_context_simple) }))
          }, 'Before wiping text instructions');
          
          // Update by movement_id (most reliable) AND by key patterns (fallback)
          const { rowCount: textRows } = await pool.query(
            `UPDATE cached_asset_meta 
             SET text_context = NULL, 
                 text_context_simple = NULL,
                 translation_status = NULL,
                 translation_error = NULL,
                 video_status = NULL,
                 video_error = NULL
             WHERE movement_id = $1 
             OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})`,
            [normalizedId, ...patterns]
          );
          textCount = textRows ?? 0;

          // Verify deletion
          const { rows: verifyRows } = await pool.query(
            `SELECT key, text_context, text_context_simple FROM cached_asset_meta 
             WHERE movement_id = $1 
             OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})`,
            [normalizedId, ...patterns]
          );
          const stillHasText = verifyRows.filter((r: any) => r.text_context || r.text_context_simple);
          
          req.log.info({ 
            movementId: normalizedId, 
            textRowsUpdated: textRows,
            verifyRowsCount: verifyRows.length,
            stillHasTextCount: stillHasText.length,
            stillHasTextSample: stillHasText.slice(0, 3).map((r: any) => r.key)
          }, 'After wiping text instructions');

          // 4. Delete translation jobs for these assets
          const { rowCount: transJobs } = await pool.query(
            `DELETE FROM translation_jobs 
             WHERE asset_key IN (
               SELECT key FROM cached_asset_meta 
               WHERE movement_id = $1 
               OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})
             )`,
            [normalizedId, ...patterns]
          );
          translationJobCount = transJobs ?? 0;

          // 5. Delete video jobs for these assets
          const { rowCount: vidJobs } = await pool.query(
            `DELETE FROM video_jobs 
             WHERE asset_key IN (
               SELECT key FROM cached_asset_meta 
               WHERE movement_id = $1 
               OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})
             )`,
            [normalizedId, ...patterns]
          );
          videoJobCount = vidJobs ?? 0;
        }

        req.log.info({ movementId, type, imageCount, textCount, translationJobCount, videoJobCount }, 'Wiped asset data');
        return reply.send({ 
          success: true, 
          message: `Wiped ${imageCount} images${wipeText ? `, ${textCount} text instructions, ${translationJobCount} translation jobs, ${videoJobCount} video jobs` : ''} for ${movementId}`, 
          deletedCount: imageCount,
          textCleared: textCount,
          translationJobsDeleted: translationJobCount,
          videoJobsDeleted: videoJobCount
        });
      } else {
        // Wipe ALL (optionally filtered by type)
        let keyFilter = '';
        if (type === 'exercise') {
          keyFilter = ` AND (key LIKE 'ex:%' OR key LIKE 'ex_%')`;
        } else if (type === 'meal') {
          keyFilter = ` AND (key LIKE 'meal:%' OR key LIKE 'meal_%')`;
        } else {
          keyFilter = ` AND (key LIKE 'ex:%' OR key LIKE 'meal:%' OR key LIKE 'ex_%' OR key LIKE 'meal_%')`;
        }

        // 1. Delete images
        const { rowCount: imageCountRaw } = await pool.query(
          `DELETE FROM cached_assets 
           WHERE asset_type = 'image' 
           AND key NOT LIKE '%:meta:%'${keyFilter}`
        );
        const imageCount = imageCountRaw ?? 0;

        await pool.query(
          `DELETE FROM asset_blob_storage 
           WHERE 1=1${keyFilter}`
        );

        let textCount = 0;
        let translationJobCount = 0;
        let videoJobCount = 0;

        if (wipeText) {
          // 2. Clear text instructions (match by key patterns)
          const { rowCount: textRows } = await pool.query(
            `UPDATE cached_asset_meta 
             SET text_context = NULL, 
                 text_context_simple = NULL,
                 translation_status = NULL,
                 translation_error = NULL,
                 video_status = NULL,
                 video_error = NULL
             WHERE 1=1${keyFilter}`
          );
          textCount = textRows ?? 0;
          req.log.info({ type, textRowsUpdated: textRows }, 'Wiping all text instructions');

          // 3. Delete translation jobs
          const { rowCount: transJobs } = await pool.query(
            `DELETE FROM translation_jobs 
             WHERE asset_key IN (
               SELECT key FROM cached_asset_meta WHERE 1=1${keyFilter}
             )`
          );
          translationJobCount = transJobs ?? 0;

          // 4. Delete video jobs
          const { rowCount: vidJobs } = await pool.query(
            `DELETE FROM video_jobs 
             WHERE asset_key IN (
               SELECT key FROM cached_asset_meta WHERE 1=1${keyFilter}
             )`
          );
          videoJobCount = vidJobs ?? 0;
        }

        req.log.info({ type, imageCount, textCount, translationJobCount, videoJobCount }, 'Wiped all asset data');
        return reply.send({ 
          success: true, 
          message: `Wiped ${imageCount} ${type || 'asset'} images${wipeText ? `, ${textCount} text instructions, ${translationJobCount} translation jobs, ${videoJobCount} video jobs` : ''}`, 
          deletedCount: imageCount,
          textCleared: textCount,
          translationJobsDeleted: translationJobCount,
          videoJobsDeleted: videoJobCount
        });
      }
    } catch (e: any) {
      req.log.error({ error: e, movementId: req.body?.movementId, type: req.body?.type }, 'Wipe asset data failed');
      return reply.status(500).send({ error: `Failed to wipe asset data: ${e.message}` });
    }
  });

  // WIPE TEXT INSTRUCTIONS ONLY (separate from images)
  app.post('/admin/wipe-asset-text', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const body = z.object({
        movementId: z.string().optional(),
        type: z.enum(['meal', 'exercise']).optional()
      }).parse(req.body);

      const { movementId, type } = body;

      if (movementId) {
        const normalizedId = normalizeToMovementId(movementId);
        const prefix = type === 'exercise' ? 'ex' : (type === 'meal' ? 'meal' : null);
        
        let patterns: string[];
        if (prefix) {
          patterns = [
            `${prefix}:${normalizedId}:%`,
            `${prefix}_${normalizedId}%`
          ];
        } else {
          patterns = [
            `ex:${normalizedId}:%`,
            `meal:${normalizedId}:%`,
            `ex_${normalizedId}%`,
            `meal_${normalizedId}%`,
            `${normalizedId}%`
          ];
        }

        // Clear text by movement_id (most reliable) AND key patterns
        const { rowCount: textRows } = await pool.query(
          `UPDATE cached_asset_meta 
           SET text_context = NULL, 
               text_context_simple = NULL,
               translation_status = NULL,
               translation_error = NULL,
               video_status = NULL,
               video_error = NULL
           WHERE movement_id = $1 
           OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})`,
          [normalizedId, ...patterns]
        );

        // Delete translation and video jobs
        const { rowCount: transJobs } = await pool.query(
          `DELETE FROM translation_jobs 
           WHERE asset_key IN (
             SELECT key FROM cached_asset_meta 
             WHERE movement_id = $1 
             OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})
           )`,
          [normalizedId, ...patterns]
        );

        const { rowCount: vidJobs } = await pool.query(
          `DELETE FROM video_jobs 
           WHERE asset_key IN (
             SELECT key FROM cached_asset_meta 
             WHERE movement_id = $1 
             OR (${patterns.map((_, i) => `key LIKE $${i + 2}`).join(' OR ')})
           )`,
          [normalizedId, ...patterns]
        );

        const t = textRows ?? 0;
        const tr = transJobs ?? 0;
        const v = vidJobs ?? 0;
        req.log.info({ movementId: normalizedId, type, textRows: t, transJobs: tr, vidJobs: v }, 'Wiped text instructions');
        return reply.send({
          success: true,
          message: `Wiped ${t} text instructions, ${tr} translation jobs, ${v} video jobs for ${movementId}`,
          textCleared: t,
          translationJobsDeleted: tr,
          videoJobsDeleted: v
        });
      } else {
        // Wipe ALL text (optionally filtered by type)
        let keyFilter = '';
        if (type === 'exercise') {
          keyFilter = ` AND (key LIKE 'ex:%' OR key LIKE 'ex_%')`;
        } else if (type === 'meal') {
          keyFilter = ` AND (key LIKE 'meal:%' OR key LIKE 'meal_%')`;
        } else {
          keyFilter = ` AND (key LIKE 'ex:%' OR key LIKE 'meal:%' OR key LIKE 'ex_%' OR key LIKE 'meal_%')`;
        }

        const { rowCount: textRows } = await pool.query(
          `UPDATE cached_asset_meta 
           SET text_context = NULL, 
               text_context_simple = NULL,
               translation_status = NULL,
               translation_error = NULL,
               video_status = NULL,
               video_error = NULL
           WHERE 1=1${keyFilter}`
        );

        const { rowCount: transJobs } = await pool.query(
          `DELETE FROM translation_jobs 
           WHERE asset_key IN (
             SELECT key FROM cached_asset_meta WHERE 1=1${keyFilter}
           )`
        );

        const { rowCount: vidJobs } = await pool.query(
          `DELETE FROM video_jobs 
           WHERE asset_key IN (
             SELECT key FROM cached_asset_meta WHERE 1=1${keyFilter}
           )`
        );

        const t2 = textRows ?? 0;
        const tr2 = transJobs ?? 0;
        const v2 = vidJobs ?? 0;
        req.log.info({ type, textRows: t2, transJobs: tr2, vidJobs: v2 }, 'Wiped all text instructions');
        return reply.send({
          success: true,
          message: `Wiped ${t2} ${type || 'asset'} text instructions, ${tr2} translation jobs, ${v2} video jobs`,
          textCleared: t2,
          translationJobsDeleted: tr2,
          videoJobsDeleted: v2
        });
      }
    } catch (e: any) {
      req.log.error({ error: e, movementId: req.body?.movementId, type: req.body?.type }, 'Wipe text failed');
      return reply.status(500).send({ error: `Failed to wipe text: ${e.message}` });
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

  // Cleanup orphaned assets (not referenced by any active movement)
  app.post('/admin/assets/cleanup-orphaned', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      req.log.info('[cleanup-orphaned] Starting orphaned asset cleanup');
      
      // 1. Get all active movements
      const { exercises: exRows, meals: mealRows } = await MovementRepository.getMovementManifest();
      
      // 2. Build set of all "in-use" asset keys
      const inUseKeys = new Set<string>();
      
      // System assets that should never be deleted
      const systemKeys = [
        'system_coach_atlas_ref',
        'system_coach_nova_ref',
        'system_background_gym_ref',
        'system_background_kitchen_ref',
        'system_blueprints'
      ];
      systemKeys.forEach(k => inUseKeys.add(k));
      
      // Generate expected keys for each exercise
      for (const ex of exRows) {
        const movementId = normalizeToMovementId(ex.name);
        const stepCount = ex.metadata?.instructions?.length || ex.metadata?.steps?.length || 8;
        const expectedKeys = await UnifiedAssetService.getManifest('ex', movementId, ex.name, stepCount);
        expectedKeys.forEach(k => inUseKeys.add(k));
      }
      
      // Generate expected keys for each meal
      for (const meal of mealRows) {
        const movementId = normalizeToMovementId(meal.name);
        const stepCount = meal.instructions?.length || 8;
        const expectedKeys = await UnifiedAssetService.getManifest('meal', movementId, meal.name, stepCount);
        expectedKeys.forEach(k => inUseKeys.add(k));
      }
      
      req.log.info({ inUseCount: inUseKeys.size }, '[cleanup-orphaned] Built in-use key set');
      
      // 3. Find orphaned assets (assets not in inUseKeys set)
      const { rows: allAssets } = await pool.query(
        `SELECT key FROM cached_assets WHERE key NOT LIKE 'system_%'`
      );
      
      const orphanedKeys = allAssets
        .map((r: any) => r.key)
        .filter((key: string) => !inUseKeys.has(key));
      
      req.log.info({ orphanedCount: orphanedKeys.length, sample: orphanedKeys.slice(0, 10) }, '[cleanup-orphaned] Found orphaned assets');
      
      if (orphanedKeys.length === 0) {
        return reply.send({ 
          success: true, 
          deletedCount: 0, 
          message: 'No orphaned assets found' 
        });
      }
      
      // 4. Delete orphaned assets
      // Delete from cached_assets
      const { rowCount: assetsDeleted } = await pool.query(
        `DELETE FROM cached_assets WHERE key = ANY($1)`,
        [orphanedKeys]
      );
      
      // Delete from asset_blob_storage
      await pool.query(
        `DELETE FROM asset_blob_storage WHERE key = ANY($1)`,
        [orphanedKeys]
      );
      
      // Delete from cached_asset_meta
      await pool.query(
        `DELETE FROM cached_asset_meta WHERE key = ANY($1)`,
        [orphanedKeys]
      );
      
      // Delete related translation/video jobs
      await pool.query(
        `DELETE FROM translation_jobs WHERE asset_key = ANY($1)`,
        [orphanedKeys]
      );
      await pool.query(
        `DELETE FROM video_jobs WHERE asset_key = ANY($1)`,
        [orphanedKeys]
      );
      
      const deletedCount = assetsDeleted ?? 0;
      req.log.info({ deletedCount, orphanedKeys: orphanedKeys.length }, '[cleanup-orphaned] Cleanup complete');
      
      return reply.send({ 
        success: true, 
        deletedCount,
        orphanedKeysCount: orphanedKeys.length,
        message: `Deleted ${deletedCount} orphaned assets` 
      });
    } catch (e: any) {
      req.log.error({ err: e }, '[cleanup-orphaned] Error');
      return reply.status(500).send({ 
        error: String(e?.message ?? 'Cleanup failed'),
        requestId: (req as any).requestId ?? 'unknown'
      });
    }
  });

  // Cleanup orphaned assets scoped to a single movement (SAFE MODE)
  // This prevents deleting assets for other movements that may still be on legacy key formats.
  app.post('/admin/assets/cleanup-orphaned-scoped', { preHandler: adminGuard }, async (req: any, reply: any) => {
    try {
      const body = z.object({
        movementId: z.string().min(1),
        type: z.enum(['exercise', 'meal'])
      }).parse(req.body || {});

      const { movementId, type } = body;
      const keyType = type === 'exercise' ? 'ex' : 'meal';

      req.log.info({ movementId, type }, '[cleanup-orphaned-scoped] Starting scoped cleanup');

      // Only consider assets whose slug EXACTLY equals movementId (type:slug:persona:subtype:index).
      // CRITICAL: LIKE 'ex:ankle_alphabet:%' would also match ex:ankle_alphabet_ankle_sprain:... and
      // getManifest only returns ex:ankle_alphabet:... so those would be wrongly deleted. Filter by exact slug.
      const likePattern = `${keyType}:${movementId}:%`;
      const { rows: rawScoped } = await pool.query(
        `SELECT key FROM cached_assets WHERE key LIKE $1 AND key NOT LIKE 'system_%'`,
        [likePattern]
      );
      const scopedAssets = rawScoped.filter((r: any) => {
        const parts = (r.key as string).split(':');
        return parts.length >= 2 && parts[1] === movementId;
      });

      // Determine stepCount from existing scoped keys (prevents deleting valid steps due to wrong count)
      let stepCount = type === 'exercise' ? 10 : 8;
      try {
        let maxStep = 0;
        for (const r of scopedAssets) {
          const k: string = r.key;
          const parts = k.split(':');
          // UnifiedKey: type:slug:persona:subtype:index
          if (parts.length === 5 && parts[3] === 'step') {
            const idx = parseInt(parts[4], 10);
            if (!Number.isNaN(idx) && idx > maxStep) maxStep = idx;
          }
        }
        if (maxStep > 0) stepCount = maxStep;
      } catch {
        // ignore; fallback remains
      }

      // Build expected keys for this specific movement only using derived stepCount
      const expectedKeys = await UnifiedAssetService.getManifest(keyType as any, movementId, movementId, stepCount);
      const inUseKeys = new Set<string>([
        'system_coach_atlas_ref',
        'system_coach_nova_ref',
        'system_background_gym_ref',
        'system_background_kitchen_ref',
        'system_blueprints',
        ...expectedKeys
      ]);

      const orphanedKeys = scopedAssets
        .map((r: any) => r.key)
        .filter((k: string) => !inUseKeys.has(k));

      req.log.info({ movementId, type, stepCount, scopedCount: scopedAssets.length, orphanedCount: orphanedKeys.length }, '[cleanup-orphaned-scoped] Computed scoped orphan set');

      if (orphanedKeys.length === 0) {
        return reply.send({
          success: true,
          deletedCount: 0,
          orphanedKeysCount: 0,
          message: 'No scoped orphaned assets found'
        });
      }

      // Delete orphaned assets only for this movement scope
      const { rowCount: assetsDeleted } = await pool.query(
        `DELETE FROM cached_assets WHERE key = ANY($1)`,
        [orphanedKeys]
      );
      await pool.query(`DELETE FROM asset_blob_storage WHERE key = ANY($1)`, [orphanedKeys]);
      await pool.query(`DELETE FROM cached_asset_meta WHERE key = ANY($1)`, [orphanedKeys]);
      await pool.query(`DELETE FROM translation_jobs WHERE asset_key = ANY($1)`, [orphanedKeys]);
      await pool.query(`DELETE FROM video_jobs WHERE asset_key = ANY($1)`, [orphanedKeys]);

      const deletedCount = assetsDeleted ?? 0;
      req.log.info({ movementId, type, deletedCount }, '[cleanup-orphaned-scoped] Scoped cleanup complete');

      return reply.send({
        success: true,
        deletedCount,
        orphanedKeysCount: orphanedKeys.length,
        message: `Deleted ${assetsDeleted} scoped orphaned assets`
      });
    } catch (e: any) {
      req.log.error({ err: e }, '[cleanup-orphaned-scoped] Error');
      return reply.status(500).send({
        error: String(e?.message ?? 'Scoped cleanup failed'),
        requestId: (req as any).requestId ?? 'unknown'
      });
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

    // FIX: Add CORS headers for Server-Sent Events (required for cross-origin SSE)
    const origin = req.headers.origin || '*';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'false');
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering for SSE
    reply.raw.flushHeaders();

    const onUpdate = (progress: any) => {
      // FIX: Wrap progress in SSE message format expected by frontend
      const message = {
        type: progress.status === 'completed' ? 'complete' : (progress.status === 'failed' ? 'error' : 'progress'),
        total: progress.total,
        completed: progress.completed,
        failed: progress.failed,
        currentItem: progress.currentItem || '',
        error: progress.error
      };
      reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    // Send initial state
    const current = jobManager.getJob(jobId);
    if (current) {
      req.log.info({ msg: 'SSE stream started', jobId, initialStatus: current.status });
      onUpdate(current);
    } else {
      req.log.warn({ msg: 'Job not found for SSE stream', jobId });
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Job not found' })}\n\n`);
    }

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
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        for (const item of ids) {
          let movement = null;
          const isUUID = uuidRegex.test(item.id);

          if (isUUID) {
            movement = item.type === 'ex'
              ? await MovementRepository.findExerciseById(item.id)
              : await MovementRepository.findMealById(item.id);
          } else {
            // Fallback: Try to find by NAME if ID isn't a UUID
            // (Fixes "invalid input syntax for type uuid" when frontend sends names)
            movement = item.type === 'ex'
              ? await MovementRepository.findExerciseByName(item.id)
              : await MovementRepository.findMealByName(item.id);
          }

          if (movement) {
            itemsToProcess.push({ type: item.type, id: movement.id, name: movement.name });
          } else {
            req.log.warn(`Batch item not found: ${item.id} (Type: ${item.type})`);
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
        req.log.warn({ msg: 'Batch generation: No items to process', mode, type, ids, count });
        return reply.status(400).send({ error: 'No items found for generation' });
      }

      req.log.info({ msg: 'Batch generation: Processing items', itemCount: itemsToProcess.length, items: itemsToProcess.map(i => ({ type: i.type, name: i.name })) });

      // Calculate total steps across all manifests - DYNAMIC based on instructions
      let totalSteps = 0;
      const tasks: string[] = [];
      for (const item of itemsToProcess) {
        // FIX: Load instructions first to get dynamic step count
        let stepCount = 6; // Default fallback
        try {
          const movementId = AssetPromptService.normalizeToId(item.name);
          // CRITICAL FIX: Use UnifiedKey format for meta key (was using old underscore format)
          const metaKey = item.type === 'ex' 
            ? `ex:${movementId}:none:meta:0` 
            : `meal:${movementId}:none:meta:0`;
          const metaAsset = await AssetRepository.findByKey(metaKey);
          if (metaAsset?.value) {
            const parsed = JSON.parse(metaAsset.value);
            if (parsed.instructions && Array.isArray(parsed.instructions)) {
              stepCount = Math.min(parsed.instructions.length, 10); // Cap at MAX_STEPS (10)
            }
          } else if (metaAsset?.buffer) {
            const parsed = JSON.parse(metaAsset.buffer.toString());
            if (parsed.instructions && Array.isArray(parsed.instructions)) {
              stepCount = Math.min(parsed.instructions.length, 10); // Cap at MAX_STEPS (10)
            }
          }
          // Ensure stepCount is at least 1 and capped at 10
          stepCount = Math.max(1, Math.min(stepCount, 10));
        } catch (e) {
          // If meta doesn't exist yet, use default - will be generated first
        }
        
        // CRITICAL: Use slug (normalized name) for manifest, not UUID - manifest generates keys like ex:slug:nova:main:0
        const movementSlug = AssetPromptService.normalizeToId(item.name);
        const manifest = await UnifiedAssetService.getManifest(item.type, movementSlug, item.name, stepCount);
        req.log.info({ msg: 'Manifest generated', itemName: item.name, movementSlug, stepCount, manifestKeys: manifest.filter(k => k.includes(':nova:main:') || k.includes(':atlas:main:')), totalKeys: manifest.length });
        tasks.push(...manifest);
        totalSteps += manifest.length;
      }

      req.log.info({ msg: 'Creating batch job', jobId, totalSteps, taskCount: tasks.length, itemsCount: itemsToProcess.length });
      jobManager.createJob(jobId, totalSteps);

      // Async process with comprehensive error handling and logging
      (async () => {
        const processedMovementIds = new Set<string>();
        let processedCount = 0;
        
        req.log.info({ msg: 'Batch processing started', jobId, totalTasks: tasks.length });
        
        for (const key of tasks) {
          try {
            const currentJob = jobManager.getJob(jobId);
            if (!currentJob) {
              req.log.warn({ msg: 'Job not found, stopping batch', jobId });
              break;
            }

            processedCount++;
            req.log.info({ msg: 'Processing asset', jobId, key, progress: `${processedCount}/${tasks.length}` });
            jobManager.updateProgress(jobId, { currentItem: key });
            
            const result = await AssetOrchestrator.generateAssetForKey(key);
            req.log.info({ msg: 'Asset generation result', jobId, key, result });

            if (result === 'SUCCESS' || result === 'EXISTS') {
              const currentCompleted = (jobManager.getJob(jobId)?.completed || 0) + 1;
              jobManager.updateProgress(jobId, { completed: currentCompleted });
              req.log.info({ msg: 'Asset completed', jobId, key, completed: currentCompleted, total: totalSteps });
              
              // Track movement IDs for translation triggering
              try {
                const uKey = UnifiedKey.parse(key);
                if (uKey) {
                  const movementId = AssetPromptService.normalizeToId(uKey.id);
                  processedMovementIds.add(movementId);
                }
              } catch (e) {
                req.log.warn({ msg: 'Key parsing error', key, error: (e as any).message });
              }
            } else if (result === 'FAILED') {
              const currentFailed = (jobManager.getJob(jobId)?.failed || 0) + 1;
              jobManager.updateProgress(jobId, { failed: currentFailed });
              req.log.warn({ msg: 'Asset generation failed', jobId, key, failed: currentFailed });
            } else {
              const currentSkipped = (jobManager.getJob(jobId)?.skipped || 0) + 1;
              jobManager.updateProgress(jobId, { skipped: currentSkipped });
              req.log.info({ msg: 'Asset skipped', jobId, key, result, skipped: currentSkipped });
            }
          } catch (e: any) {
            const currentFailed = (jobManager.getJob(jobId)?.failed || 0) + 1;
            jobManager.updateProgress(jobId, { failed: currentFailed });
            req.log.error({ msg: 'Asset generation exception', jobId, key, error: e.message, stack: e.stack });
          }
        }
        
        const finalJob = jobManager.getJob(jobId);
        req.log.info({ msg: 'Batch processing completed', jobId, finalStatus: finalJob?.status, completed: finalJob?.completed, failed: finalJob?.failed, skipped: finalJob?.skipped });
        
        // FIX: Trigger translations for all processed movements
        if (processedMovementIds.size > 0) {
          try {
            const { TranslationService } = await import('../../../application/services/translationService.js');
            const translationService = new TranslationService();
            
            for (const movementId of processedMovementIds) {
              // Determine type from first item
              const firstItem = itemsToProcess[0];
              const groupType = firstItem.type === 'ex' ? 'exercise' : 'meal';
              const groupName = firstItem.name;
              
              // Trigger translations in background (don't await to avoid blocking)
              translationService.publishAndTranslate(movementId, groupName, groupType).catch((e: any) => {
                req.log.warn({ msg: `Failed to trigger translations for ${movementId}`, error: e.message });
              });
            }
            
            req.log.info({ msg: `Triggered translations for ${processedMovementIds.size} movements` });
          } catch (e: any) {
            req.log.warn({ msg: 'Failed to trigger translations after batch', error: e.message });
          }
        }
      })().catch(err => {
        req.log.error({ msg: "Batch processing crash", jobId, error: err.message, stack: err.stack });
        const currentJob = jobManager.getJob(jobId);
        if (currentJob) {
          jobManager.updateProgress(jobId, { status: 'failed', error: err.message });
        }
      });

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

