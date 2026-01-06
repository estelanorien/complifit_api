import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

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
  timestamp: z.any().optional(),
  linkedPlanItemId: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  metadata: z.any().optional()
});

const exerciseSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  date: z.string(),
  time: z.string().optional(),
  sets: z.any().optional(),
  location: z.any().optional(),
  estimatedCalories: z.number().optional(),
  verification: z.any().optional(),
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
  sets: z.any().optional(),
  location: z.any().optional(),
  verification: z.any().optional(),
  estimatedCalories: z.number().optional()
});

export async function logsRoutes(app: FastifyInstance) {
  // FOOD LOG
  app.get('/logs/food', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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
    const user = (req as any).user;
    const items = z.array(foodSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      await client.query('DELETE FROM food_logs_simple WHERE user_id = $1', [user.userId]);
      for (const item of items) {
        // ID'yi tamamen backend'e bırak (frontend geçici ID'lerini asla kullanma)
        await client.query(
          `INSERT INTO food_logs_simple(user_id, name, calories, protein, carbs, fat, status, match_accuracy, timestamp, linked_plan_item_id, image_url, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, $11, $12)`,
          [user.userId, item.name, item.calories, item.protein, item.carbs, item.fat, item.status, item.matchAccuracy, item.timestamp, item.linkedPlanItemId, item.imageUrl, item.metadata]
        );
      }
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Food log save failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to save food log' : (e.message || 'Food log save failed') });
    } finally {
      client.release();
    }
  });

  // EXERCISE LOG
  app.get('/logs/exercise', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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
    const user = (req as any).user;
    const items = z.array(exerciseSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      await client.query('DELETE FROM exercise_logs_simple WHERE user_id = $1', [user.userId]);
      for (const item of items) {
        const safeId = isValidUuid(item.id) ? item.id : null;
        await client.query(
          `INSERT INTO exercise_logs_simple(id, user_id, name, date, time, sets, location, estimated_calories, verification, is_negotiated)
           VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [safeId, user.userId, item.name, item.date, item.time || null, item.sets, item.location, item.estimatedCalories, item.verification, item.isNegotiated || false]
        );
      }
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Exercise log save failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to save exercise log' : (e.message || 'Exercise log save failed') });
    } finally {
      client.release();
    }
  });

  // PLAN COMPLETION LOG
  app.get('/logs/plan-completion', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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
    const user = (req as any).user;
    const items = z.array(planCompletionSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      await client.query('DELETE FROM plan_completion_logs WHERE user_id = $1', [user.userId]);
      for (const item of items) {
        const safeId = isValidUuid(item.id) ? item.id : null;
        await client.query(
          `INSERT INTO plan_completion_logs(id, user_id, plan_id, day_index, meal_index, date)
           VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)`,
          [safeId, user.userId, item.planId, item.dayIndex, item.mealIndex, item.date]
        );
      }
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Plan completion log save failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to save plan completion log' : (e.message || 'Plan completion log save failed') });
    } finally {
      client.release();
    }
  });

  // EXTRA EXERCISE LOG
  app.get('/logs/extra-exercise', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
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
    const user = (req as any).user;
    const items = z.array(extraExerciseSchema).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      await client.query('DELETE FROM extra_exercise_logs WHERE user_id = $1', [user.userId]);
      try {
        for (const item of items) {
          const safeId = isValidUuid(item.id) ? item.id : null;
          await client.query(
            `INSERT INTO extra_exercise_logs(id, user_id, name, date, time, sets, location, verification, estimated_calories)
             VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9)`,
            [safeId, user.userId, item.name, item.date, item.time || null, item.sets, item.location, item.verification, item.estimatedCalories]
          );
        }
      } catch (e: any) {
        // Fallback for deployments missing "time" column
        if (e.message && e.message.includes('column "time"')) {
          for (const item of items) {
            const safeId = isValidUuid(item.id) ? item.id : null;
            await client.query(
              `INSERT INTO extra_exercise_logs(id, user_id, name, date, sets, location, verification, estimated_calories)
               VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)`,
              [safeId, user.userId, item.name, item.date, item.sets, item.location, item.verification, item.estimatedCalories]
            );
          }
        } else {
          throw e;
        }
      }
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Extra exercise log save failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to save extra exercise log' : (e.message || 'Extra exercise log save failed') });
    } finally {
      client.release();
    }
  });

  // DAY CONCLUSION
  app.post('/logs/conclude-day', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
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
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Day conclusion save failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to save day conclusion' : (e.message || 'Day conclusion save failed') });
    }
  });

  app.get('/logs/day-conclusion/:date', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const { date } = req.params as { date: string };

    try {
      const { rows } = await pool.query(
        `SELECT * FROM day_conclusions WHERE user_id = $1 AND date = $2`,
        [user.userId, date]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Day conclusion not found' });
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
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Day conclusion fetch failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to fetch day conclusion' : (e.message || 'Day conclusion fetch failed') });
    }
  });

  // Get current streak count from database
  app.get('/logs/streak-count', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) as count FROM day_conclusions 
         WHERE user_id = $1 
         ORDER BY date DESC`,
        [user.userId]
      );
      
      return reply.send({ streakCount: parseInt(rows[0]?.count || '0') });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      console.error('Streak count fetch failed', e);
      return reply.status(500).send({ error: isProduction ? 'Failed to fetch streak count' : (e.message || 'Streak count fetch failed') });
    }
  });
}

