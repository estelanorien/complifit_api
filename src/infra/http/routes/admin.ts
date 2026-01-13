import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import fetch from 'node-fetch';
import { env } from '../../../config/env';
import { uploadToYouTube } from '../../../services/youtubeService';

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
  // Asset generation proxy (server-side Gemini key)
  app.post('/admin/generate-asset', { preHandler: adminGuard }, async (req, reply) => {
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    const body = assetGenSchema.parse(req.body || {});
    const { mode, prompt, key, status, movementId, imageInput } = body;

    let value: string | null = null;
    try {
      // Helper to prepare parts
      const parts: any[] = [{ text: prompt }];
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

      if (mode === 'image') {
        // gemini-2.5-flash-image for image generation
        const model = 'models/gemini-2.5-flash-image';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts }]
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
        const model = 'models/gemini-2.5-flash';
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
        value = text;
      } else {
        // Attempt Real Veo Generation (with fallback)
        // Note: 'veo-001-preview' is the model name for private preview
        const model = 'models/veo-001-preview';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

        try {
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
            // Fallback if not allowed/found
            throw new Error(`Veo not available (${res.status})`);
          }

          const data: any = await res.json();
          // Veo response structure might differ, but assuming unified API for now:
          const videoUri = data?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri;
          if (videoUri) {
            value = videoUri;
          } else {
            // If it returns text instead or wait-token
            value = "https://assets.mixkit.co/videos/preview/mixkit-man-doing-push-ups-at-gym-2623-large.mp4"; // Mock fallback
          }
        } catch (e) {
          // Fallback to Mock Video for demo purposes if Veo fails (likely due to access)
          req.log?.warn({ msg: "Veo generation failed, using mock", error: e });
          value = `https://assets.mixkit.co/videos/preview/mixkit-man-doing-push-ups-at-gym-2623-large.mp4`;
        }
      }

      if (value && key) {
        await pool.query(
          `INSERT INTO cached_assets(key, value, asset_type, status)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, asset_type=EXCLUDED.asset_type, status=EXCLUDED.status`,
          [key, value, mode === 'json' ? 'json' : mode, status]
        );
        // meta
        await pool.query(
          `INSERT INTO cached_asset_meta(key, prompt, mode, source, created_by, movement_id)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (key) DO UPDATE SET prompt=EXCLUDED.prompt, mode=EXCLUDED.mode, source=EXCLUDED.source, created_by=EXCLUDED.created_by, movement_id=EXCLUDED.movement_id`,
          [key, prompt, mode, 'admin_generate_asset', (req as any).user?.userId || null, movementId || null]
        );
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

  app.post('/admin/upload-video', { preHandler: adminGuard }, async (req, reply) => {
    try {
      const body = uploadSchema.parse(req.body);
      const result = await uploadToYouTube(body);
      return reply.send(result);
    } catch (e: any) {
      req.log.error({ error: 'youtube upload failed', e });
      return reply.status(500).send({ error: e.message });
    }
  });



  // Simple seed stubs (extend as needed)
  app.post('/admin/seed', { preHandler: adminGuard }, async (req, reply) => {
    seedSchema.parse(req.body || {});
    // TODO: Implement actual seed logic
    return reply.send({ success: true });
  });

  // User listing (basic)
  app.get('/admin/users', { preHandler: adminGuard }, async () => {
    const { rows } = await pool.query(
      `SELECT u.id as user_id, u.email, u.role, p.profile_data
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT 200`
    );
    return rows.map(r => ({
      user_id: r.user_id,
      email: r.email,
      role: r.role || 'user',
      profile: r.profile_data
    }));
  });

  // User role update
  app.post('/admin/users/role', { preHandler: adminGuard }, async (req, reply) => {
    const body = roleSchema.parse(req.body || {});
    await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2`,
      [body.newRole, body.targetUserId]
    );
    return reply.send({ success: true });
  });

  // Get all movements (exercises and meals) from database
  app.get('/admin/movements', { preHandler: adminGuard }, async (req) => {
    try {
      // Helper function to normalize name to movement_id format (without prefix, frontend will add ex_ or meal_)
      // Matches frontend normalizeKey logic: sorts words for consistency
      const normalizeToMovementId = (name: string): string => {
        if (!name) return 'unknown';
        let clean = name.toLowerCase().trim();
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        const words = clean.split(' ').filter((w: string) => w.length > 0).sort();
        return words.join('_');
      };

      const exerciseMap = new Map<string, any>();
      const mealMap = new Map<string, any>();

      // 1. Get unique exercise names from training_exercises table with METADATA
      try {
        const exerciseRows = await pool.query(
          `SELECT DISTINCT ON (name) name, metadata
           FROM training_exercises
           WHERE name IS NOT NULL AND name != ''
           ORDER BY name, created_at DESC`
        );
        exerciseRows.rows.forEach((row: any) => {
          if (row.name) {
            exerciseMap.set(row.name, {
              name: row.name,
              metadata: row.metadata
            });
          }
        });
      } catch (e: any) {
        req.log?.warn({ error: 'Failed to fetch from training_exercises', message: e.message });
      }

      // 2. Get unique meal names from meals table with INSTRUCTIONS
      try {
        const mealRows = await pool.query(
          `SELECT DISTINCT ON (name) name, instructions
           FROM meals
           WHERE name IS NOT NULL AND name != ''
           ORDER BY name, created_at DESC`
        );
        mealRows.rows.forEach((row: any) => {
          if (row.name) {
            mealMap.set(row.name, {
              name: row.name,
              instructions: row.instructions
            });
          }
        });
      } catch (e: any) {
        req.log?.warn({ error: 'Failed to fetch from meals', message: e.message });
      }

      // 3. Also extract from user_profiles (current plans) as fallback
      try {
        const profileRows = await pool.query(
          `SELECT profile_data FROM user_profiles WHERE profile_data IS NOT NULL`
        );

        for (const row of profileRows.rows) {
          const profile = row.profile_data || {};

          // Extract exercises from currentTrainingProgram
          if (profile.currentTrainingProgram?.schedule) {
            for (const day of profile.currentTrainingProgram.schedule) {
              if (Array.isArray(day.exercises)) {
                for (const ex of day.exercises) {
                  if (ex.name && !exerciseMap.has(ex.name)) {
                    // Fallback: Use profile data if DB didn't have it
                    exerciseMap.set(ex.name, {
                      name: ex.name,
                      metadata: { instructions: ex.instructions } // Map standard instructions to metadata structure
                    });
                  }
                }
              }
            }
          }

          // Extract meals from currentMealPlan
          if (profile.currentMealPlan?.days) {
            for (const day of profile.currentMealPlan.days) {
              if (Array.isArray(day.meals)) {
                for (const meal of day.meals) {
                  const mealName = meal.recipe?.name || meal.name;
                  if (mealName && !mealMap.has(mealName)) {
                    mealMap.set(mealName, {
                      name: mealName,
                      instructions: meal.recipe?.instructions || meal.instructions
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e: any) {
        req.log?.warn({ error: 'Failed to fetch from user_profiles', message: e.message });
      }

      // Convert maps to arrays and create response
      const exercises = Array.from(exerciseMap.values()).map((ex) => {
        const movementId = normalizeToMovementId(ex.name);
        return {
          id: movementId,
          name: ex.name,
          movementId,
          metadata: ex.metadata
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      const meals = Array.from(mealMap.values()).map((m) => {
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
      req.log?.error({ error: 'admin movements fetch failed', message: e.message, stack: e.stack });
      return { exercises: [], meals: [] };
    }
  });
}

