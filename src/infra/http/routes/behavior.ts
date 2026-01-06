import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

export async function behaviorRoutes(app: FastifyInstance) {
  const configSchema = z.object({
    config: z.record(z.any()),
    label: z.string().optional(),
    activate: z.boolean().optional()
  });

  const eventSchema = z.object({
    configId: z.string().uuid().optional(),
    source: z.string(),
    eventType: z.string(),
    payload: z.any().optional(),
    outcome: z.any().optional()
  });

  const listEventsSchema = z.object({
    limit: z.coerce.number().min(1).max(200).default(50)
  });

  app.get('/behavior/config', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, config, active, label, created_at, updated_at
       FROM behavior_configs
       WHERE user_id = $1 AND active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      [user.userId]
    );
    if (rows.length === 0) return null;
    const cfg = rows[0];
    return {
      id: cfg.id,
      config: cfg.config,
      active: cfg.active,
      label: cfg.label,
      createdAt: cfg.created_at,
      updatedAt: cfg.updated_at
    };
  });

  app.put('/behavior/config', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = configSchema.parse(req.body);
    const activate = body.activate ?? true;
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      if (activate) {
        await client.query(
          `UPDATE behavior_configs
           SET active = false, updated_at = now()
           WHERE user_id = $1 AND active = true`,
          [user.userId]
        );
      }
      const { rows } = await client.query(
        `INSERT INTO behavior_configs(user_id, config, active, label)
         VALUES($1, $2::jsonb, $3, $4)
         RETURNING id, config, active, label, created_at, updated_at`,
        [
          user.userId,
          JSON.stringify(body.config),
          activate,
          body.label || null
        ]
      );
      await client.query('COMMIT');
      return reply.send(rows[0]);
    } catch (e: any) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'behavior config save failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Behavior config save failed' });
    } finally {
      client.release();
    }
  });

  app.get('/behavior/events', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const query = listEventsSchema.parse(req.query ?? {});
    const { rows } = await pool.query(
      `SELECT id, config_id, source, event_type, payload, outcome, created_at
       FROM behavior_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [user.userId, query.limit]
    );
    return rows.map((r: any) => ({
      id: r.id,
      configId: r.config_id,
      source: r.source,
      eventType: r.event_type,
      payload: r.payload,
      outcome: r.outcome,
      createdAt: r.created_at
    }));
  });

  app.post('/behavior/events', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = eventSchema.parse(req.body);
    let configId = body.configId || null;

    if (!configId) {
      const { rows } = await pool.query(
        `SELECT id FROM behavior_configs
         WHERE user_id = $1 AND active = true
         ORDER BY updated_at DESC
         LIMIT 1`,
        [user.userId]
      );
      configId = rows[0]?.id || null;
    }

    const { rows } = await pool.query(
      `INSERT INTO behavior_events(user_id, config_id, source, event_type, payload, outcome)
       VALUES($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        user.userId,
        configId,
        body.source,
        body.eventType,
        body.payload ? JSON.stringify(body.payload) : null,
        body.outcome ? JSON.stringify(body.outcome) : null
      ]
    );
    return reply.send({
      id: rows[0].id,
      configId,
      createdAt: rows[0].created_at
    });
  });
}


