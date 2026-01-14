import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminGuard, authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
// Native fetch used
import { env } from '../../../config/env.js';
import { uploadToYouTube } from '../../../services/youtubeService.js';
import bcrypt from 'bcryptjs';

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
        const model = 'gemini-2.5-flash-image';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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
        const model = 'models/gemini-3-flash-preview';
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

  // Note: /admin/users route is defined later with search functionality

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

  // ================== ADMIN USER MANAGEMENT ==================

  // Admin: Reset user password
  app.post('/admin/users/:userId/reset-password', { preHandler: [authGuard, adminGuard] }, async (req, reply) => {
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
  app.patch('/admin/users/:userId/profile', { preHandler: [authGuard, adminGuard] }, async (req, reply) => {
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
  app.get('/admin/users', { preHandler: [authGuard, adminGuard] }, async (req, reply) => {
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

