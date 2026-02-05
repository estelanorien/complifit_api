import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

const foodSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  // Frontend bazen string/null gönderebiliyor; hepsini number'a çevirip opsiyonel yap
  calories: z.coerce.number().optional().nullable(),
  protein: z.coerce.number().optional().nullable(),
  carbs: z.coerce.number().optional().nullable(),
  fat: z.coerce.number().optional().nullable(),
  status: z.string().optional(),
  matchAccuracy: z.coerce.number().optional().nullable(),
  timestamp: z.coerce.date().optional(),
  linkedPlanItemId: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  metadata: z.record(z.any()).optional()
});

const exerciseSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  date: z.string(),
  time: z.string().optional(),
  sets: z.array(z.record(z.any())).optional(),
  location: z.string().optional(),
  estimatedCalories: z.coerce.number().optional(),
  verification: z.record(z.any()).optional(),
  isNegotiated: z.boolean().optional()
});

const planCompletionSchema = z.object({
  id: z.string().optional(),
  planId: z.string(),
  dayIndex: z.number(),
  mealIndex: z.number(),
  date: z.string()
});

const extraExerciseSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  date: z.string(),
  time: z.string().optional(),
  sets: z.array(z.record(z.any())).optional(),
  location: z.string().optional(),
  verification: z.record(z.any()).optional(),
  estimatedCalories: z.coerce.number().optional()
});

const weightSchema = z.object({
  id: z.string().optional(),
  weight: z.number(),
  unit: z.string().default('kg'),
  date: z.string()
});

export async function logsRoutes(app: FastifyInstance) {
  // FOOD LOG
  app.get('/logs/food', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT id, name, calories, protein, carbs, fat, status, match_accuracy, timestamp, linked_plan_item_id, image_url, metadata
       FROM food_logs_simple WHERE user_id = $1 ORDER BY timestamp DESC`,
      [user.userId]
    );
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      calories: r.calories,
      protein: r.protein,
      carbs: r.carbs,
      fat: r.fat,
      status: r.status,
      matchAccuracy: r.match_accuracy,
      timestamp: r.timestamp,
      linkedPlanItemId: r.linked_plan_item_id,
      image: r.image_url,
      metadata: r.metadata
    }));
  });

  const isValidUuid = (id: string | undefined | null) => {
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  };

  app.post('/logs/food', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const items = z.array(foodSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      await client.query('BEGIN');

      const syncedIds: string[] = [];
      const updatedItems = [];

      for (const item of items) {
        const id = isValidUuid(item.id) ? item.id : gen_random_uuid_manual();

        const { rows } = await client.query(
          `INSERT INTO food_logs_simple(id, user_id, name, calories, protein, carbs, fat, status, match_accuracy, timestamp, linked_plan_item_id, image_url, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()), $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             calories = EXCLUDED.calories,
             protein = EXCLUDED.protein,
             carbs = EXCLUDED.carbs,
             fat = EXCLUDED.fat,
             status = EXCLUDED.status,
             match_accuracy = EXCLUDED.match_accuracy,
             timestamp = EXCLUDED.timestamp,
             linked_plan_item_id = EXCLUDED.linked_plan_item_id,
             image_url = EXCLUDED.image_url,
             metadata = EXCLUDED.metadata
           RETURNING id`,
          [id, user.userId, item.name, item.calories, item.protein, item.carbs, item.fat, item.status, item.matchAccuracy, item.timestamp, item.linkedPlanItemId, item.imageUrl, item.metadata]
        );

        const savedId = rows[0].id;
        syncedIds.push(savedId);
        updatedItems.push({ ...item, id: savedId });
      }

      // Selective Delete: Remove items NOT in the incoming batch
      if (syncedIds.length > 0) {
        await client.query(
          `DELETE FROM food_logs_simple WHERE user_id = $1 AND id NOT IN (SELECT unnest($2::text[]))`,
          [user.userId, syncedIds]
        );
      } else {
        await client.query('DELETE FROM food_logs_simple WHERE user_id = $1', [user.userId]);
      }

      await client.query('COMMIT');
      return reply.send({ success: true, items: updatedItems });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'Food log sync failed', e });
      return reply.status(500).send({ error: 'Failed to sync food log' });
    } finally {
      client.release();
    }
  });

  function gen_random_uuid_manual() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // EXERCISE LOG
  app.get('/logs/exercise', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    try {
      // Try to select with time column (if migration 015 has run)
      const { rows } = await pool.query(
        `SELECT id, name, date, time, sets, location, estimated_calories, verification, is_negotiated
         FROM exercise_logs_simple WHERE user_id = $1 ORDER BY date DESC, time DESC NULLS LAST`,
        [user.userId]
      );
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        date: r.date,
        time: r.time || null,
        sets: r.sets,
        location: r.location,
        estimatedCalories: r.estimated_calories,
        verification: r.verification,
        isNegotiated: r.is_negotiated
      }));
    } catch (error: any) {
      // If time column doesn't exist, select without it
      if (error.message && error.message.includes('column "time" does not exist')) {
        const { rows } = await pool.query(
          `SELECT id, name, date, sets, location, estimated_calories, verification, is_negotiated
           FROM exercise_logs_simple WHERE user_id = $1 ORDER BY date DESC, created_at DESC`,
          [user.userId]
        );
        return rows.map(r => ({
          id: r.id,
          name: r.name,
          date: r.date,
          time: null,
          sets: r.sets,
          location: r.location,
          estimatedCalories: r.estimated_calories,
          verification: r.verification,
          isNegotiated: r.is_negotiated
        }));
      }
      throw error;
    }
  });

  app.post('/logs/exercise', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const items = z.array(exerciseSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      await client.query('BEGIN');

      const syncedIds: string[] = [];
      const updatedItems = [];

      for (const item of items) {
        const id = isValidUuid(item.id) ? item.id : gen_random_uuid_manual();

        const { rows } = await client.query(
          `INSERT INTO exercise_logs_simple(id, user_id, name, date, time, sets, location, estimated_calories, verification, is_negotiated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             date = EXCLUDED.date,
             time = EXCLUDED.time,
             sets = EXCLUDED.sets,
             location = EXCLUDED.location,
             estimated_calories = EXCLUDED.estimated_calories,
             verification = EXCLUDED.verification,
             is_negotiated = EXCLUDED.is_negotiated
           RETURNING id`,
          [id, user.userId, item.name, item.date, item.time || null, item.sets, item.location, item.estimatedCalories, item.verification, item.isNegotiated || false]
        );

        const savedId = rows[0].id;
        syncedIds.push(savedId);
        updatedItems.push({ ...item, id: savedId });
      }

      if (syncedIds.length > 0) {
        await client.query(
          `DELETE FROM exercise_logs_simple WHERE user_id = $1 AND id NOT IN (SELECT unnest($2::text[]))`,
          [user.userId, syncedIds]
        );
      } else {
        await client.query('DELETE FROM exercise_logs_simple WHERE user_id = $1', [user.userId]);
      }

      await client.query('COMMIT');
      return reply.send({ success: true, items: updatedItems });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'Exercise log sync failed', e });
      return reply.status(500).send({ error: 'Failed to sync exercise log' });
    } finally {
      client.release();
    }
  });

  // PLAN COMPLETION LOG
  app.get('/logs/plan-completion', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT id, plan_id, day_index, meal_index, date FROM plan_completion_logs WHERE user_id = $1 ORDER BY date DESC`,
      [user.userId]
    );
    return rows.map(r => ({
      id: r.id,
      planId: r.plan_id,
      dayIndex: r.day_index,
      mealIndex: r.meal_index,
      date: r.date
    }));
  });

  app.post('/logs/plan-completion', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const items = z.array(planCompletionSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      await client.query('BEGIN');

      const syncedIds: string[] = [];
      const updatedItems = [];

      for (const item of items) {
        const id = isValidUuid(item.id) ? item.id : gen_random_uuid_manual();

        const { rows } = await client.query(
          `INSERT INTO plan_completion_logs(id, user_id, plan_id, day_index, meal_index, date)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             plan_id = EXCLUDED.plan_id,
             day_index = EXCLUDED.day_index,
             meal_index = EXCLUDED.meal_index,
             date = EXCLUDED.date
           RETURNING id`,
          [id, user.userId, item.planId, item.dayIndex, item.mealIndex, item.date]
        );

        const savedId = rows[0].id;
        syncedIds.push(savedId);
        updatedItems.push({ ...item, id: savedId });
      }

      if (syncedIds.length > 0) {
        await client.query(
          `DELETE FROM plan_completion_logs WHERE user_id = $1 AND id NOT IN (SELECT unnest($2::text[]))`,
          [user.userId, syncedIds]
        );
      } else {
        await client.query('DELETE FROM plan_completion_logs WHERE user_id = $1', [user.userId]);
      }

      await client.query('COMMIT');
      return reply.send({ success: true, items: updatedItems });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'Plan completion log sync failed', e });
      return reply.status(500).send({ error: 'Failed to sync plan completion log' });
    } finally {
      client.release();
    }
  });

  // EXTRA EXERCISE LOG
  app.get('/logs/extra-exercise', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT id, name, date, time, sets, location, verification, estimated_calories FROM extra_exercise_logs WHERE user_id = $1 ORDER BY date DESC, time DESC NULLS LAST`,
      [user.userId]
    );
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      date: r.date,
      time: r.time,
      sets: r.sets,
      location: r.location,
      verification: r.verification,
      estimatedCalories: r.estimated_calories
    }));
  });

  app.post('/logs/extra-exercise', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const items = z.array(extraExerciseSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      await client.query('BEGIN');

      const syncedIds: string[] = [];
      const updatedItems = [];

      for (const item of items) {
        const id = isValidUuid(item.id) ? item.id : gen_random_uuid_manual();

        const { rows } = await client.query(
          `INSERT INTO extra_exercise_logs(id, user_id, name, date, time, sets, location, verification, estimated_calories)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             date = EXCLUDED.date,
             time = EXCLUDED.time,
             sets = EXCLUDED.sets,
             location = EXCLUDED.location,
             verification = EXCLUDED.verification,
             estimated_calories = EXCLUDED.estimated_calories
           RETURNING id`,
          [id, user.userId, item.name, item.date, item.time || null, item.sets, item.location, item.verification, item.estimatedCalories]
        );

        const savedId = rows[0].id;
        syncedIds.push(savedId);
        updatedItems.push({ ...item, id: savedId });
      }

      if (syncedIds.length > 0) {
        await client.query(
          `DELETE FROM extra_exercise_logs WHERE user_id = $1 AND id NOT IN (SELECT unnest($2::text[]))`,
          [user.userId, syncedIds]
        );
      } else {
        await client.query('DELETE FROM extra_exercise_logs WHERE user_id = $1', [user.userId]);
      }

      await client.query('COMMIT');
      return reply.send({ success: true, items: updatedItems });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'Extra exercise log sync failed', e });
      return reply.status(500).send({ error: 'Failed to sync extra exercise log' });
    } finally {
      client.release();
    }
  });

  // DAY CONCLUSION
  app.post('/logs/conclude-day', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const schema = z.object({
      date: z.string(),
      totalCaloriesConsumed: z.number().default(0),
      totalCaloriesBurned: z.number().default(0),
      netBalance: z.number().default(0),
      mealsCompleted: z.number().default(0),
      workoutsCompleted: z.number().default(0),
      streakCount: z.number().default(0),
      xpEarned: z.number().default(0),
      coinsEarned: z.number().default(0),
      summaryData: z.any().optional()
    });

    try {
      const data = schema.parse(req.body);

      await pool.query(
        `INSERT INTO day_conclusions(user_id, date, total_calories_consumed, total_calories_burned, net_balance, 
          meals_completed, workouts_completed, streak_count, xp_earned, coins_earned, summary_data, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (user_id, date) DO UPDATE SET
          total_calories_consumed = EXCLUDED.total_calories_consumed,
          total_calories_burned = EXCLUDED.total_calories_burned,
          net_balance = EXCLUDED.net_balance,
          meals_completed = EXCLUDED.meals_completed,
          workouts_completed = EXCLUDED.workouts_completed,
          streak_count = EXCLUDED.streak_count,
          xp_earned = EXCLUDED.xp_earned,
          coins_earned = EXCLUDED.coins_earned,
          summary_data = EXCLUDED.summary_data`,
        [user.userId, data.date, data.totalCaloriesConsumed, data.totalCaloriesBurned, data.netBalance,
        data.mealsCompleted, data.workoutsCompleted, data.streakCount, data.xpEarned, data.coinsEarned, JSON.stringify(data.summaryData || {})]
      );

      return reply.send({ success: true });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'Day conclusion save failed', e, requestId: req.id });
      return reply.status(500).send({ error: isProduction ? 'Failed to save day conclusion' : (error.message || 'Day conclusion save failed') });
    }
  });

  app.get('/logs/day-conclusion/:date', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { date } = req.params as { date: string };

    try {
      const { rows } = await pool.query(
        `SELECT * FROM day_conclusions WHERE user_id = $1 AND date = $2`,
        [user.userId, date]
      );

      if (rows.length === 0) {
        return reply.send({ dayConclusion: null, message: 'No conclusion generated yet for this date' });
      }

      return reply.send({
        date: rows[0].date,
        totalCaloriesConsumed: rows[0].total_calories_consumed,
        totalCaloriesBurned: rows[0].total_calories_burned,
        netBalance: rows[0].net_balance,
        mealsCompleted: rows[0].meals_completed,
        workoutsCompleted: rows[0].workouts_completed,
        streakCount: rows[0].streak_count,
        xpEarned: rows[0].xp_earned,
        coinsEarned: rows[0].coins_earned,
        summaryData: rows[0].summary_data,
        createdAt: rows[0].created_at
      });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'Day conclusion fetch failed', e, requestId: req.id });
      return reply.status(500).send({ error: isProduction ? 'Failed to fetch day conclusion' : (error.message || 'Day conclusion fetch failed') });
    }
  });

  app.delete('/logs/day-conclusion/:date', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { date } = req.params as { date: string };

    try {
      await pool.query(
        `DELETE FROM day_conclusions WHERE user_id = $1 AND date = $2`,
        [user.userId, date]
      );
      return reply.send({ success: true });
    } catch (e: unknown) {
      req.log.error({ error: 'Day conclusion delete failed', e });
      return reply.status(500).send({ error: 'Failed to delete day conclusion' });
    }
  });

  // Get current streak count from database
  app.get('/logs/streak-count', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) as count FROM day_conclusions 
         WHERE user_id = $1 
         ORDER BY date DESC`,
        [user.userId]
      );

      return reply.send({ streakCount: parseInt(rows[0]?.count || '0') });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'Streak count fetch failed', e, requestId: req.id });
      return reply.status(500).send({ error: isProduction ? 'Failed to fetch streak count' : (error.message || 'Streak count fetch failed') });
    }
  });

  // WEIGHT LOG
  app.get('/logs/weight', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT id, weight, unit, date FROM weight_logs WHERE user_id = $1 ORDER BY date DESC, created_at DESC LIMIT 100`,
      [user.userId]
    );
    return rows.map(r => ({
      id: r.id,
      weight: parseFloat(r.weight),
      unit: r.unit,
      date: r.date
    }));
  });

  app.post('/logs/weight', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const items = z.array(weightSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      await client.query('BEGIN');

      const syncedIds: string[] = [];
      const updatedItems = [];

      for (const item of items) {
        const id = isValidUuid(item.id) ? item.id : gen_random_uuid_manual();

        const { rows } = await client.query(
          `INSERT INTO weight_logs(id, user_id, weight, unit, date)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             weight = EXCLUDED.weight,
             unit = EXCLUDED.unit,
             date = EXCLUDED.date
           RETURNING id`,
          [id, user.userId, item.weight, item.unit, item.date]
        );

        const savedId = rows[0].id;
        syncedIds.push(savedId);
        updatedItems.push({ ...item, id: savedId });
      }

      if (syncedIds.length > 0) {
        await client.query(
          `DELETE FROM weight_logs WHERE user_id = $1 AND id NOT IN (SELECT unnest($2::text[]))`,
          [user.userId, syncedIds]
        );
      } else {
        await client.query('DELETE FROM weight_logs WHERE user_id = $1', [user.userId]);
      }

      await client.query('COMMIT');
      return reply.send({ success: true, items: updatedItems });
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'Weight log sync failed', e });
      return reply.status(500).send({ error: 'Failed to sync weight log' });
    } finally {
      client.release();
    }
  });

  // HEALTH METRICS (from Apple Health / Google Fit sync)
  const healthMetricsSchema = z.object({
    date: z.string(),
    steps: z.number().default(0),
    activeEnergyKcal: z.number().default(0),
    sleepMinutes: z.number().default(0),
    restingHeartRate: z.number().default(0),
    hrv: z.number().default(0),
    source: z.string().optional()
  });

  app.post('/logs/health-metrics', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    try {
      const data = healthMetricsSchema.parse(req.body);

      await pool.query(
        `INSERT INTO health_metrics(user_id, date, steps, active_energy_kcal, sleep_minutes, resting_heart_rate, hrv, source, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_id, date) DO UPDATE SET
           steps = EXCLUDED.steps,
           active_energy_kcal = EXCLUDED.active_energy_kcal,
           sleep_minutes = EXCLUDED.sleep_minutes,
           resting_heart_rate = EXCLUDED.resting_heart_rate,
           hrv = EXCLUDED.hrv,
           source = EXCLUDED.source,
           updated_at = now()`,
        [user.userId, data.date, data.steps, data.activeEnergyKcal, data.sleepMinutes, data.restingHeartRate, data.hrv, data.source || 'unknown']
      );

      return reply.send({ success: true });
    } catch (e: unknown) {
      req.log.error({ error: 'Health metrics save failed', e });
      return reply.status(500).send({ error: 'Failed to save health metrics' });
    }
  });
}

