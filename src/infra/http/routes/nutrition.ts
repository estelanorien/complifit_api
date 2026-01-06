import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import { MealPlan, generateNutritionPlan } from '../../../application/services/nutritionService';

const toJsonOrNull = (value: any) => {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
};

const saveMealPlanToDb = async (client: any, userId: string, mealPlan: MealPlan, startDate?: string) => {
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
    const user = (req as any).user;
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
      } catch (e: any) {
        await client.query('ROLLBACK');
        req.log.error({ error: 'nutrition generate save failed', e, requestId: (req as any).requestId });
        return reply.status(500).send({ error: e.message || 'Nutrition save failed' });
      } finally {
        client.release();
      }
    } catch (e: any) {
      req.log.error({ error: 'Nutrition generate failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Nutrition generate failed' });
    }
  });

  const archiveSchema = z.object({
    name: z.string(),
    plan: z.any(),
    progressDayIndex: z.number().optional(),
    summary: z.string().optional()
  });

  app.get('/nutrition/archives', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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
    const user = (req as any).user;
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
    const user = (req as any).user;
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
    } catch (e: any) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'nutrition archive load failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Archive load failed' });
    } finally {
      client.release();
    }
  });

  app.patch('/nutrition/archives/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
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
    const user = (req as any).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const res = await pool.query(
      `DELETE FROM meal_archives WHERE id = $1 AND user_id = $2`,
      [id, user.userId]
    );
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });
}


