import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

export async function timelineRoutes(app: FastifyInstance) {
  const listModsSchema = z.object({
    day: z.string().optional(),
    limit: z.coerce.number().min(1).max(200).default(50)
  });

  const modSchema = z.object({
    timelineItemId: z.string().optional(),
    day: z.string(),
    action: z.string(),
    previousData: z.any().optional(),
    newData: z.any().optional(),
    reason: z.string().optional()
  });

  const wakeQuerySchema = z.object({
    date: z.string().optional(),
    limit: z.coerce.number().min(1).max(30).default(10)
  });

  const wakeUpsertSchema = z.object({
    eventDate: z.string(),
    plannedTime: z.string(),
    detectedTime: z.string().optional(),
    source: z.string().default('manual'),
    notes: z.string().optional()
  });

  app.get('/timeline/mods', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const query = listModsSchema.parse(req.query ?? {});
    const values: (string | number)[] = [user.userId];
    let where = 'user_id = $1';
    let index = 2;

    if (query.day) {
      where += ` AND day = $${index}`;
      values.push(query.day);
      index += 1;
    }

    values.push(query.limit);

    const { rows } = await pool.query(
      `SELECT id, timeline_item_id, day, action, previous_data, new_data, reason, created_at
       FROM timeline_modifications
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${index}`,
      values
    );

    return rows.map((r: any) => ({
      id: r.id,
      timelineItemId: r.timeline_item_id,
      day: r.day,
      action: r.action,
      previousData: r.previous_data,
      newData: r.new_data,
      reason: r.reason,
      createdAt: r.created_at
    }));
  });

  // Helper function to check if a string is a valid UUID
  const isValidUUID = (str: string | undefined | null): boolean => {
    if (!str) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  };

  app.post('/timeline/mods', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = modSchema.parse(req.body);

    // Only use timelineItemId if it's a valid UUID, otherwise set to null
    // Frontend sends IDs like "meal-0-0" which are not UUIDs
    const timelineItemId = body.timelineItemId && isValidUUID(body.timelineItemId)
      ? body.timelineItemId
      : null;

    const { rows } = await pool.query(
      `INSERT INTO timeline_modifications(
         id, user_id, timeline_item_id, day, action, previous_data, new_data, reason, created_at
       )
       VALUES(
         gen_random_uuid(), $1, $2, $3::date, $4, $5::jsonb, $6::jsonb, $7, now()
       )
       RETURNING id, timeline_item_id, day, action, previous_data, new_data, reason, created_at`,
      [
        user.userId,
        timelineItemId,
        body.day,
        body.action,
        body.previousData ? JSON.stringify(body.previousData) : null,
        body.newData ? JSON.stringify(body.newData) : null,
        body.reason || null
      ]
    );

    return reply.send({
      id: rows[0].id,
      timelineItemId: rows[0].timeline_item_id,
      day: rows[0].day,
      action: rows[0].action,
      previousData: rows[0].previous_data,
      newData: rows[0].new_data,
      reason: rows[0].reason,
      createdAt: rows[0].created_at
    });
  });

  app.delete('/timeline/mods/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rowCount } = await pool.query(
      `DELETE FROM timeline_modifications WHERE id = $1 AND user_id = $2`,
      [params.id, user.userId]
    );
    if (rowCount === 0) {
      return reply.status(404).send({ error: 'Modification not found' });
    }
    return reply.send({ success: true });
  });

  app.get('/timeline/wake', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const query = wakeQuerySchema.parse(req.query ?? {});
    const values: (string | number)[] = [user.userId];
    let where = 'user_id = $1';
    let index = 2;

    if (query.date) {
      where += ` AND event_date = $${index}`;
      values.push(query.date);
      index += 1;
    }

    values.push(query.limit);

    const { rows } = await pool.query(
      `SELECT id, event_date, planned_time, detected_time, source, notes, created_at
       FROM wake_events
       WHERE ${where}
       ORDER BY event_date DESC
       LIMIT $${index}`,
      values
    );

    return rows.map((r: any) => ({
      id: r.id,
      eventDate: r.event_date,
      plannedTime: r.planned_time,
      detectedTime: r.detected_time,
      source: r.source,
      notes: r.notes,
      createdAt: r.created_at
    }));
  });

  app.post('/timeline/wake', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = wakeUpsertSchema.parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO wake_events(id, user_id, event_date, planned_time, detected_time, source, notes)
       VALUES(gen_random_uuid(), $1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (user_id, event_date) DO UPDATE
       SET planned_time = EXCLUDED.planned_time,
           detected_time = EXCLUDED.detected_time,
           source = EXCLUDED.source,
           notes = EXCLUDED.notes
       RETURNING id, event_date, planned_time, detected_time, source, notes, created_at`,
      [
        user.userId,
        body.eventDate,
        body.plannedTime,
        body.detectedTime || null,
        body.source,
        body.notes || null
      ]
    );

    return reply.send({
      id: rows[0].id,
      eventDate: rows[0].event_date,
      plannedTime: rows[0].planned_time,
      detectedTime: rows[0].detected_time,
      source: rows[0].source,
      notes: rows[0].notes,
      createdAt: rows[0].created_at
    });
  });

  // Smart Wake Confirm - Captures actual wake time and calculates rescheduling
  const smartWakeSchema = z.object({
    eventDate: z.string(),
    plannedWakeTime: z.string(), // HH:MM format
    actualWakeTime: z.string(),  // HH:MM format (current time)
    sleepTime: z.string(),       // HH:MM format (planned sleep time)
    pendingItems: z.array(z.object({
      id: z.string(),
      type: z.enum(['meal', 'workout', 'snack', 'pre_workout', 'post_workout', 'other']),
      plannedTime: z.string(),
      name: z.string(),
      calories: z.number().optional(),
      intensity: z.enum(['low', 'moderate', 'high']).optional(),
      durationMinutes: z.number().optional()
    }))
  });

  // Medically validated timing constants (in minutes)
  const TIMING_RULES = {
    FIRST_MEAL_AFTER_WAKE: 30,
    MIN_GAP_MAIN_MEALS: 180,      // 3 hours
    MIN_GAP_SNACK_TO_MEAL: 90,    // 1.5 hours
    PRE_WORKOUT_BEFORE: 45,
    POST_WORKOUT_AFTER: 30,
    HEAVY_MEAL_BEFORE_SLEEP: 180, // 3 hours
    LIGHT_SNACK_BEFORE_SLEEP: 90, // 1.5 hours
    INTENSE_WORKOUT_BEFORE_SLEEP: 240, // 4 hours
    MODERATE_WORKOUT_BEFORE_SLEEP: 120, // 2 hours
    LIGHT_WORKOUT_BEFORE_SLEEP: 60      // 1 hour
  };

  const timeToMinutes = (timeStr: string): number => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };

  const minutesToTime = (mins: number): string => {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  app.post('/timeline/wake/confirm', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = smartWakeSchema.parse(req.body);

    const plannedWakeMins = timeToMinutes(body.plannedWakeTime);
    const actualWakeMins = timeToMinutes(body.actualWakeTime);
    const sleepMins = timeToMinutes(body.sleepTime);
    const delayMinutes = actualWakeMins - plannedWakeMins;

    // Calculate available time until sleep
    const availableMinutes = sleepMins - actualWakeMins - TIMING_RULES.HEAVY_MEAL_BEFORE_SLEEP;

    const rescheduledItems: any[] = [];
    const skippedItems: any[] = [];
    const missedItems: any[] = [];

    // Separate past and future items
    for (const item of body.pendingItems) {
      const itemMins = timeToMinutes(item.plannedTime);
      if (itemMins < actualWakeMins) {
        missedItems.push(item);
      }
    }

    // Schedule future items with proper gaps
    let nextSlot = actualWakeMins + TIMING_RULES.FIRST_MEAL_AFTER_WAKE;
    let lastMealTime = 0;
    let workoutScheduled = false;
    let workoutEndTime = 0;

    // Sort items by type priority: workout first (to anchor other items), then meals
    const futureItems = body.pendingItems
      .filter(item => timeToMinutes(item.plannedTime) >= actualWakeMins)
      .sort((a, b) => {
        const priority: Record<string, number> = { workout: 1, meal: 2, pre_workout: 3, post_workout: 4, snack: 5, other: 6 };
        return (priority[a.type] || 6) - (priority[b.type] || 6);
      });

    // First pass: schedule workout if possible
    for (const item of futureItems) {
      if (item.type === 'workout') {
        const workoutDuration = item.durationMinutes || 60;
        const intensity = item.intensity || 'moderate';
        const minBeforeSleep = intensity === 'high' ? TIMING_RULES.INTENSE_WORKOUT_BEFORE_SLEEP
          : intensity === 'moderate' ? TIMING_RULES.MODERATE_WORKOUT_BEFORE_SLEEP
            : TIMING_RULES.LIGHT_WORKOUT_BEFORE_SLEEP;

        const latestWorkoutStart = sleepMins - minBeforeSleep - workoutDuration;

        if (nextSlot + workoutDuration < latestWorkoutStart) {
          // Can fit workout - schedule it mid-day
          const workoutStart = Math.min(nextSlot + 90, latestWorkoutStart - 60);
          rescheduledItems.push({ ...item, newTime: minutesToTime(workoutStart), reason: 'Rescheduled to fit late wake' });
          workoutScheduled = true;
          workoutEndTime = workoutStart + workoutDuration;
        } else {
          // Can't fit workout safely
          skippedItems.push({ ...item, reason: `Cannot fit ${intensity} workout before sleep cutoff (${minBeforeSleep / 60}h)` });
        }
      }
    }

    // Second pass: schedule meals around workout
    for (const item of futureItems) {
      if (item.type === 'meal' || item.type === 'snack') {
        const isMainMeal = item.type === 'meal';
        const minGap = isMainMeal ? TIMING_RULES.MIN_GAP_MAIN_MEALS : TIMING_RULES.MIN_GAP_SNACK_TO_MEAL;
        const sleepCutoff = isMainMeal ? TIMING_RULES.HEAVY_MEAL_BEFORE_SLEEP : TIMING_RULES.LIGHT_SNACK_BEFORE_SLEEP;

        // Find next available slot respecting gaps
        if (lastMealTime > 0) {
          nextSlot = Math.max(nextSlot, lastMealTime + minGap);
        }

        // Check sleep cutoff
        if (nextSlot + sleepCutoff > sleepMins) {
          skippedItems.push({ ...item, reason: `Too close to bedtime (need ${sleepCutoff / 60}h gap)` });
          continue;
        }

        // Schedule the meal
        rescheduledItems.push({ ...item, newTime: minutesToTime(nextSlot), reason: 'Rescheduled after late wake' });
        lastMealTime = nextSlot;
        nextSlot += 30; // Eating duration
      }
      else if (item.type === 'pre_workout' && workoutScheduled) {
        // Schedule pre-workout before workout
        const preWorkoutTime = workoutEndTime - (item.durationMinutes || 60) - TIMING_RULES.PRE_WORKOUT_BEFORE;
        rescheduledItems.push({ ...item, newTime: minutesToTime(preWorkoutTime), reason: 'Synced with rescheduled workout' });
      }
      else if (item.type === 'post_workout' && workoutScheduled) {
        // Schedule post-workout after workout
        const postWorkoutTime = workoutEndTime + TIMING_RULES.POST_WORKOUT_AFTER;
        rescheduledItems.push({ ...item, newTime: minutesToTime(postWorkoutTime), reason: 'Synced with rescheduled workout' });
      }
    }

    // Save to database
    await pool.query(
      `INSERT INTO wake_events(id, user_id, event_date, planned_time, detected_time, actual_wake_time, delay_minutes, rescheduled_items, skipped_items, source)
       VALUES(gen_random_uuid(), $1, $2::date, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'smart_wake')
       ON CONFLICT (user_id, event_date) DO UPDATE
       SET planned_time = EXCLUDED.planned_time,
           detected_time = EXCLUDED.detected_time,
           actual_wake_time = EXCLUDED.actual_wake_time,
           delay_minutes = EXCLUDED.delay_minutes,
           rescheduled_items = EXCLUDED.rescheduled_items,
           skipped_items = EXCLUDED.skipped_items,
           source = EXCLUDED.source`,
      [
        user.userId,
        body.eventDate,
        body.plannedWakeTime,
        body.actualWakeTime,
        body.actualWakeTime,
        delayMinutes,
        JSON.stringify(rescheduledItems),
        JSON.stringify(skippedItems)
      ]
    );

    return reply.send({
      success: true,
      actualWakeTime: body.actualWakeTime,
      delayMinutes,
      availableHours: Math.floor(availableMinutes / 60),
      missedItems,
      rescheduledItems,
      skippedItems,
      timingRules: TIMING_RULES
    });
  });
}


