import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

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
    const user = (req as any).user;
    const query = listModsSchema.parse(req.query ?? {});
    const values: any[] = [user.userId];
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
    const user = (req as any).user;
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
    const user = (req as any).user;
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
    const user = (req as any).user;
    const query = wakeQuerySchema.parse(req.query ?? {});
    const values: any[] = [user.userId];
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
    const user = (req as any).user;
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
}


