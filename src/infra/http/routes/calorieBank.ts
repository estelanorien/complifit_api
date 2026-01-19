import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import fetch from 'node-fetch';
import { env } from '../../../config/env.js';

export async function calorieBankRoutes(app: FastifyInstance) {
  const txSchema = z.object({
    type: z.string(),
    amount: z.number(),
    description: z.string().optional(),
    impact: z.any().optional()
  });

  app.get('/calorie-bank/transactions', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, type, amount, description, impact, created_at
       FROM calorie_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      amount: r.amount,
      description: r.description,
      impact: r.impact,
      createdAt: r.created_at
    }));
  });

  app.post('/calorie-bank/transactions', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = txSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO calorie_transactions(user_id, type, amount, description, impact)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id, created_at`,
      [user.userId, body.type, body.amount, body.description || null, body.impact || null]
    );
    // Update profile debt
    await pool.query(
      `UPDATE user_profiles
       SET profile_data = jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{caloricDebt}',
           to_jsonb(COALESCE((profile_data->>'caloricDebt')::int, 0) + $1),
           true
         ),
         updated_at = now()
       WHERE user_id = $2`,
      [body.amount, user.userId]
    );
    return reply.send({ id: rows[0].id, createdAt: rows[0].created_at });
  });

  const eventSchema = z.object({
    duration: z.number().min(1).max(24).optional()
  });

  app.post('/calorie-bank/event', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = eventSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO event_sessions(user_id, start_time, metadata)
       VALUES($1, now(), $2)
       RETURNING id`,
      [user.userId, JSON.stringify({ durationHours: body.duration || null })]
    );
    return reply.send({ id: rows[0].id });
  });

  const eventUpdateSchema = z.object({
    accumulatedCalories: z.number().optional(),
    pendingReview: z.boolean().optional(),
    endSession: z.boolean().optional()
  });

  app.patch('/calorie-bank/event/current', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = eventUpdateSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT id, accumulated_calories
       FROM event_sessions
       WHERE user_id = $1 AND is_active = true
       ORDER BY start_time DESC
       LIMIT 1`,
      [user.userId]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'No active event' });
    const sessionId = rows[0].id;
    const newCalories = body.accumulatedCalories ?? rows[0].accumulated_calories;
    await pool.query(
      `UPDATE event_sessions
       SET accumulated_calories = $1,
           pending_review = COALESCE($2, pending_review),
           is_active = CASE WHEN $3 THEN false ELSE is_active END,
           end_time = CASE WHEN $3 THEN now() ELSE end_time END
       WHERE id = $4`,
      [newCalories, body.pendingReview ?? null, body.endSession ?? false, sessionId]
    );
    return reply.send({ success: true });
  });

  app.get('/calorie-bank/event/current', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, start_time, accumulated_calories, pending_review, is_active
       FROM event_sessions
       WHERE user_id = $1 AND is_active = true
       ORDER BY start_time DESC
       LIMIT 1`,
      [user.userId]
    );

    if (rows.length === 0) return reply.send(null);

    const session = rows[0];
    const startTime = new Date(session.start_time);
    const now = new Date();

    // Autoconclusion Logic: If start_time is a past day
    const isPastDay = startTime.toDateString() !== now.toDateString();

    if (isPastDay) {
      req.log.info({ sessionId: session.id, userId: user.userId }, 'Autoconcluding past-day event session');

      // 1. Calculate smarter review unlock time
      // If now is before 4 AM, same day neon, else next day noon
      const reviewUnlockTime = new Date(now);
      if (now.getHours() >= 4) {
        reviewUnlockTime.setDate(now.getDate() + 1);
      }
      reviewUnlockTime.setHours(12, 0, 0, 0);

      // 2. Update session in database
      await pool.query(
        `UPDATE event_sessions
         SET is_active = false,
             pending_review = true,
             end_time = now()
         WHERE id = $1`,
        [session.id]
      );

      // 3. Sync with user profile JSONB
      await pool.query(
        `UPDATE user_profiles
         SET profile_data = jsonb_set(
             jsonb_set(
               jsonb_set(
                 COALESCE(profile_data, '{}'::jsonb),
                 '{eventMode,isActive}', 'false'::jsonb
               ),
               '{eventMode,pendingReview}', 'true'::jsonb
             ),
             '{eventMode,reviewUnlockTime}', to_jsonb($1::text)
           ),
           updated_at = now()
         WHERE user_id = $2`,
        [reviewUnlockTime.toISOString(), user.userId]
      );

      return reply.send({
        ...session,
        is_active: false,
        pending_review: true
      });
    }

    return reply.send(session);
  });

  // Generate burner workout for calorie surplus
  app.post('/calorie-bank/generate-burner-workout', { preHandler: authGuard }, async (req, reply) => {
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });

    const body = z.object({
      amountToBurn: z.number().min(50).max(2000),
      profile: z.any(),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { amountToBurn, profile, lang } = body;

      const prompt = `
      GENERATE BURNER WORKOUT - CALORIE SURPLUS MITIGATION.
      
      User Profile:
      - Goal: ${profile?.primaryGoal || 'general fitness'}
      - Fitness Level: ${profile?.fitnessLevel || 'intermediate'}
      - Conditions: ${(profile?.conditions || []).join(', ') || 'None'}
      - Preferred Exercise Types: ${(profile?.preferredExerciseTypes || []).join(', ') || 'Any'}
      
      Target Calorie Burn: ${amountToBurn} kcal
      
      Task: Generate a workout plan that will burn approximately ${amountToBurn} kcal.
      Consider:
      1. User's fitness level and any health conditions
      2. Realistic exercise intensity and duration
      3. Mix of cardio and strength exercises if appropriate
      4. Safety and sustainability
      
      Return JSON:
      {
        "exercises": [
          {
            "name": "string",
            "sets": "string (e.g. '3 sets' or '20 min')",
            "reps": "string (e.g. '12 reps' or 'moderate pace')",
            "rest": "string (e.g. '60s rest')",
            "estimatedBurn": number (kcal for this exercise),
            "intensity": "low" | "moderate" | "high"
          }
        ],
        "estimatedBurn": number (total kcal, should be close to ${amountToBurn}),
        "intensity": "low" | "moderate" | "high",
        "duration": "string (e.g. '45 minutes')",
        "notes": "string (safety tips, modifications, etc.)"
      }
      
      Language: ${lang}
      `;

      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction
          ? `AI service error (${res.status})`
          : `Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

      let workout: any = {};
      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        workout = JSON.parse(cleaned);
      } catch (e) {
        req.log.error({ error: 'Failed to parse workout response', e, requestId: (req as any).requestId });
        return reply.status(500).send({ error: 'Failed to parse AI response' });
      }

      if (!workout.exercises || !Array.isArray(workout.exercises)) {
        return reply.status(500).send({ error: 'Invalid workout format from AI' });
      }

      return reply.send(workout);
    } catch (e: any) {
      req.log.error({ error: 'generate-burner-workout failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Generate burner workout failed' });
    }
  });

  // Generate reward meal for calorie credit
  app.post('/calorie-bank/generate-reward-meal', { preHandler: authGuard }, async (req, reply) => {
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });

    const body = z.object({
      creditAmount: z.number().min(100).max(1500),
      profile: z.any(),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { creditAmount, profile, lang } = body;

      const prompt = `
      GENERATE REWARD MEAL - CALORIE CREDIT REDEMPTION.
      
      User Profile:
      - Goal: ${profile?.primaryGoal || 'general fitness'}
      - Dietary Preference: ${profile?.dietaryPreference || 'standard'}
      - Excluded Ingredients: ${(profile?.excludedIngredients || []).join(', ') || 'None'}
      - Preferred Cuisines: ${(profile?.preferredCuisines || []).join(', ') || 'Any'}
      
      Available Calorie Credit: ${creditAmount} kcal
      
      Task: Generate a delicious, satisfying reward meal that:
      1. Uses approximately ${creditAmount} kcal (can be ±50 kcal)
      2. Respects dietary preferences and exclusions
      3. Is special/treat-worthy (not just a regular meal)
      4. Includes full recipe with ingredients and instructions
      5. Provides balanced macros
      
      Return JSON:
      {
        "name": "string (meal name)",
        "calories": number,
        "macros": {
          "protein": number (grams),
          "carbs": number (grams),
          "fat": number (grams)
        },
        "ingredients": ["string"],
        "instructions": ["string (step by step)"],
        "prepTime": "string (e.g. '20 minutes')",
        "cookTime": "string (e.g. '30 minutes')",
        "servings": number,
        "cuisine": "string",
        "description": "string (why this is special/treat-worthy)",
        "imagePrompt": "string (for image generation if needed)"
      }
      
      Language: ${lang}
      `;

      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.5
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction
          ? `AI service error (${res.status})`
          : `Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

      let meal: any = {};
      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        meal = JSON.parse(cleaned);
      } catch (e) {
        req.log.error({ error: 'Failed to parse meal response', e, requestId: (req as any).requestId });
        return reply.status(500).send({ error: 'Failed to parse AI response' });
      }

      if (!meal.name || !meal.calories) {
        return reply.status(500).send({ error: 'Invalid meal format from AI' });
      }

      return reply.send(meal);
    } catch (e: any) {
      req.log.error({ error: 'generate-reward-meal failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Generate reward meal failed' });
    }
  });

  // Get ledger entries (debts and credits)
  app.get('/calorie-bank/ledger', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const { status } = req.query as { status?: string };

    try {
      let query = `
        SELECT id, source_type, source_id, amount, status, created_at, resolved_at
        FROM ledger_entries
        WHERE user_id = $1
      `;
      const params: any[] = [user.userId];

      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC LIMIT 100`;

      const { rows } = await pool.query(query, params);

      return reply.send({
        entries: rows.map((r: any) => ({
          id: r.id,
          sourceType: r.source_type,
          sourceId: r.source_id,
          amount: r.amount,
          status: r.status,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at
        }))
      });
    } catch (e: any) {
      req.log.error({ error: 'Ledger fetch failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: 'Failed to fetch ledger entries' });
    }
  });
}

