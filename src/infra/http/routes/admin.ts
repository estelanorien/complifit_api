import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import fetch from 'node-fetch';
import { env } from '../../../config/env';

const assetGenSchema = z.object({
  mode: z.enum(['image', 'video', 'json']).default('image'),
  prompt: z.string().min(1),
  key: z.string().optional(),
  status: z.enum(['active', 'draft', 'auto']).default('active'),
  movementId: z.string().optional()
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
    const { mode, prompt, key, status, movementId } = body;

    let value: string | null = null;
    try {
      if (mode === 'image') {
        // Eski model: gemini-2.5-flash-image (image generation için özel model)
        const model = 'models/gemini-2.5-flash-image';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
        
        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }]}]
          })
        });
        
        if (!res.ok) {
          const errorText = await res.text();
          const isProduction = process.env.NODE_ENV === 'production';
          req.log?.error({ error: errorText, status: res.status });
          throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
        }
        
        const data: any = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const inline = parts.find((p: any) => p.inlineData?.data);
        if (inline?.inlineData?.data) {
          value = `data:image/png;base64,${inline.inlineData.data}`;
        }
      } else if (mode === 'json') {
        const model = 'models/gemini-2.0-flash-exp';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
        
        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }]}]
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
        // video placeholder: return raw text
        const model = 'models/gemini-2.0-flash-exp';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
        
        const res = await fetch(genEndpoint, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }]}]
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
      console.error('admin generate asset failed', e);
      return reply.status(500).send({ error: isProduction ? 'Asset generation service unavailable' : (e.message || 'generation failed') });
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
      `SELECT u.id as user_id, p.profile_data
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT 200`
    );
    return rows.map(r => ({ user_id: r.user_id, profile: r.profile_data }));
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

      const exerciseSet = new Set<string>();
      const mealSet = new Set<string>();

      // 1. Get unique exercise names from training_exercises table
      try {
        const exerciseRows = await pool.query(
          `SELECT DISTINCT name
           FROM training_exercises
           WHERE name IS NOT NULL AND name != ''
           ORDER BY name`
        );
        exerciseRows.rows.forEach((row: any) => {
          if (row.name) exerciseSet.add(row.name);
        });
      } catch (e: any) {
        req.log?.warn({ error: 'Failed to fetch from training_exercises', message: e.message });
      }

      // 2. Get unique meal names from meals table
      try {
        const mealRows = await pool.query(
          `SELECT DISTINCT name
           FROM meals
           WHERE name IS NOT NULL AND name != ''
           ORDER BY name`
        );
        mealRows.rows.forEach((row: any) => {
          if (row.name) mealSet.add(row.name);
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
                  if (ex.name) exerciseSet.add(ex.name);
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
                  if (mealName) mealSet.add(mealName);
                }
              }
            }
          }
        }
      } catch (e: any) {
        req.log?.warn({ error: 'Failed to fetch from user_profiles', message: e.message });
      }

      // Convert sets to arrays and create response
      const exercises = Array.from(exerciseSet).map((name) => {
        const movementId = normalizeToMovementId(name);
        return { id: movementId, name, movementId };
      }).sort((a, b) => a.name.localeCompare(b.name));

      const meals = Array.from(mealSet).map((name) => {
        const movementId = normalizeToMovementId(name);
        return { id: movementId, name, movementId };
      }).sort((a, b) => a.name.localeCompare(b.name));

      return { exercises, meals };
    } catch (e: any) {
      req.log?.error({ error: 'admin movements fetch failed', message: e.message, stack: e.stack });
      return { exercises: [], meals: [] };
    }
  });
}

