import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { MealPlan, generateNutritionPlan } from '../../../application/services/nutritionService.js';
import { AuthenticatedRequest } from '../types.js';
import { PoolClient } from 'pg';

const toJsonOrNull = (value: unknown) => {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
};

const saveMealPlanToDb = async (client: PoolClient, userId: string, mealPlan: MealPlan, startDate?: string) => {
  const mealPlanId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  await client.query(
    `INSERT INTO meal_plans(id, user_id, name, start_date, variety_mode, is_recovery, created_at)
     VALUES($1,$2,$3,$4,$5,false,now())`,
    [mealPlanId, userId, mealPlan?.name || 'Meal Plan', startDate || null, mealPlan?.varietyMode || null]
  );

  if (Array.isArray(mealPlan?.days)) {
    for (let i = 0; i < mealPlan.days.length; i++) {
      const day = mealPlan.days[i];
      const dayId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      await client.query(
        `INSERT INTO meal_plan_days(id, meal_plan_id, day_index, target_calories)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (meal_plan_id, day_index) DO NOTHING`,
        [dayId, mealPlanId, i, day.targetCalories || null]
      );
      if (Array.isArray(day.meals)) {
        for (const meal of day.meals) {
          await client.query(
            `INSERT INTO meals(id, meal_plan_day_id, type, name, calories, macros, time_label, ingredients, instructions, nutrition_tips, metadata, created_at)
             VALUES(gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, now())`,
            [
              dayId,
              meal.type || 'meal',
              meal.recipe?.name || 'Meal',
              meal.recipe?.calories || null,
              toJsonOrNull(meal.recipe?.macros),
              meal.recipe?.time || null,
              toJsonOrNull(meal.recipe?.ingredients || null),
              toJsonOrNull(meal.recipe?.instructions || null),
              toJsonOrNull((meal.recipe as any)?.nutritionTips || null),
              toJsonOrNull(meal)
            ]
          );
        }
      }
    }
  }

  await client.query(
    `UPDATE user_profiles
     SET profile_data = jsonb_set(
         jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentMealPlan}',
           $1::jsonb,
           true
         ),
         '{mealPlanStartDate}',
         to_jsonb(COALESCE($2, to_char(now(),'YYYY-MM-DD'))::text),
         true
       ),
         updated_at = now()
     WHERE user_id = $3`,
    [JSON.stringify(mealPlan), startDate || null, userId]
  );

  return mealPlanId;
};

export async function nutritionRoutes(app: FastifyInstance) {
  const generateSchema = z.object({
    profile: z.any(),
    days: z.number().min(3).max(30).default(7),
    excludes: z.array(z.string()).default([]),
    staples: z.array(z.any()).default([]),
    lang: z.string().default('en'),
    prioritizeSuperfoods: z.boolean().optional(),
    varietyMode: z.string().optional(),
    previousPlan: z.any().optional(),
    varietyInput: z.string().optional(),
    startDate: z.string().optional()
  });

  app.post('/nutrition/generate', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = generateSchema.parse(req.body);
    try {
      const nutritionPlan = await generateNutritionPlan({
        profile: body.profile,
        days: body.days,
        excludes: body.excludes,
        staples: body.staples,
        lang: body.lang,
        prioritizeSuperfoods: body.prioritizeSuperfoods,
        varietyMode: body.varietyMode,
        previousPlan: body.previousPlan,
        varietyInput: body.varietyInput
      });
      if (!Array.isArray(nutritionPlan?.days) || nutritionPlan.days.length === 0) {
        return reply.status(500).send({ error: 'Nutrition plan empty from Gemini' });
      }

      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
        await client.query('BEGIN');
        const mealPlanId = await saveMealPlanToDb(client, user.userId, nutritionPlan, body.startDate);
        await client.query('COMMIT');
        return reply.send({ nutrition: nutritionPlan, mealPlanId });
      } catch (e: unknown) {
        await client.query('ROLLBACK');
        const error = e as Error;
        req.log.error({ error: 'nutrition generate save failed', message: error.message, requestId: req.id });
        return reply.status(500).send({ error: error.message || 'Nutrition save failed' });
      } finally {
        client.release();
      }
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Nutrition generate failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Nutrition generate failed' });
    }
  });

  const archiveSchema = z.object({
    name: z.string(),
    plan: z.any(),
    progressDayIndex: z.number().optional(),
    summary: z.string().optional()
  });

  app.get('/nutrition/archives', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT id, name, date_created, plan, progress_day_index, summary
       FROM meal_archives
       WHERE user_id = $1
       ORDER BY date_created DESC`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      timestampLabel: new Date(r.date_created).toLocaleDateString(),
      plan: r.plan,
      progressDayIndex: r.progress_day_index ?? undefined,
      summary: r.summary ?? undefined
    }));
  });

  app.post('/nutrition/archives', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = archiveSchema.parse(req.body);
    const archiveId = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await pool.query(
      `INSERT INTO meal_archives(id, user_id, name, plan, progress_day_index, summary)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        archiveId,
        user.userId,
        body.name,
        JSON.stringify(body.plan),
        body.progressDayIndex ?? null,
        body.summary || null
      ]
    );
    return reply.send({ id: archiveId });
  });

  const loadArchiveSchema = z.object({
    id: z.string().uuid(),
    startDate: z.string().optional()
  });

  app.post('/nutrition/archives/load', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = loadArchiveSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT plan FROM meal_archives WHERE id = $1 AND user_id = $2`,
      [body.id, user.userId]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Archive not found' });
    const plan = rows[0].plan as MealPlan;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await saveMealPlanToDb(client, user.userId, plan, body.startDate);
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      const error = e as Error;
      req.log.error({ error: 'nutrition archive load failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Archive load failed' });
    } finally {
      client.release();
    }
  });

  app.patch('/nutrition/archives/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const body = z.object({ name: z.string() }).parse(req.body);
    const res = await pool.query(
      `UPDATE meal_archives SET name = $1 WHERE id = $2 AND user_id = $3`,
      [body.name, id, user.userId]
    );
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });

  app.delete('/nutrition/archives/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const res = await pool.query(
      `DELETE FROM meal_archives WHERE id = $1 AND user_id = $2`,
      [id, user.userId]
    );
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });

  // ============ NUTRITION LOOKUP (CalorieNinjas) ============

  const lookupSchema = z.object({
    query: z.string().min(2).max(500),
    source: z.enum(['calorieninjas', 'cache', 'auto']).default('auto')
  });

  interface NutritionItem {
    name: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber?: number;
    sugar?: number;
    servingSize?: number;
    source: string;
    confidence: number;
  }

  /**
   * POST /nutrition/lookup
   * Look up nutrition data for a food item using CalorieNinjas API
   * Results are cached in food_analysis_cache table
   */
  app.post('/nutrition/lookup', { preHandler: authGuard }, async (req, reply) => {
    const body = lookupSchema.parse(req.body);
    const queryLower = body.query.toLowerCase().trim();
    const cacheKey = queryLower.replace(/\s+/g, '_');

    // 1. Check cache first
    if (body.source === 'cache' || body.source === 'auto') {
      const { rows: cached } = await pool.query(
        `SELECT analysis FROM food_analysis_cache
         WHERE image_hash = $1
         AND created_at > NOW() - INTERVAL '7 days'`,
        [`nutrition_${cacheKey}`]
      );

      if (cached.length > 0 && cached[0].analysis) {
        return reply.send({
          items: cached[0].analysis as NutritionItem[],
          source: 'cache',
          cached: true
        });
      }
    }

    // 2. Call CalorieNinjas API
    const apiKey = process.env.CALORIENINJAS_API_KEY;
    if (!apiKey && body.source !== 'cache') {
      // No API key - return empty with warning
      req.log.warn({ msg: 'CalorieNinjas API key not configured' });
      return reply.send({
        items: [],
        source: 'none',
        cached: false,
        warning: 'Nutrition API not configured'
      });
    }

    try {
      const response = await fetch(
        `https://api.calorieninjas.com/v1/nutrition?query=${encodeURIComponent(body.query)}`,
        {
          headers: {
            'X-Api-Key': apiKey!,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        if (response.status === 429) {
          return reply.status(429).send({ error: 'Rate limit exceeded' });
        }
        throw new Error(`CalorieNinjas API error: ${response.status}`);
      }

      const data = await response.json() as { items: any[] };

      const items: NutritionItem[] = (data.items || []).map((item: any) => ({
        name: item.name,
        calories: Math.round(item.calories || 0),
        protein: Math.round((item.protein_g || 0) * 10) / 10,
        carbs: Math.round((item.carbohydrates_total_g || 0) * 10) / 10,
        fat: Math.round((item.fat_total_g || 0) * 10) / 10,
        fiber: item.fiber_g,
        sugar: item.sugar_g,
        servingSize: item.serving_size_g,
        source: 'calorieninjas',
        confidence: 0.9
      }));

      // 3. Cache the result
      if (items.length > 0) {
        await pool.query(
          `INSERT INTO food_analysis_cache(id, image_hash, analysis, created_at, accessed_at)
           VALUES(gen_random_uuid(), $1, $2, NOW(), NOW())
           ON CONFLICT (image_hash) DO UPDATE SET
             analysis = $2,
             accessed_at = NOW()`,
          [`nutrition_${cacheKey}`, JSON.stringify(items)]
        );
      }

      return reply.send({
        items,
        source: 'calorieninjas',
        cached: false
      });

    } catch (error: any) {
      req.log.error({ msg: 'Nutrition lookup failed', error: error.message });
      return reply.status(500).send({
        error: 'Nutrition lookup failed',
        details: error.message
      });
    }
  });
}


