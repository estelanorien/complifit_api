import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

export async function behaviorRoutes(app: FastifyInstance) {
  const configSchema = z.object({
    config: z.record(z.string(), z.unknown()),
    label: z.string().optional(),
    activate: z.boolean().optional()
  });

  const eventSchema = z.object({
    configId: z.string().uuid().optional(),
    source: z.string(),
    eventType: z.string(),
    payload: z.unknown().optional(),
    outcome: z.unknown().optional()
  });

  const listEventsSchema = z.object({
    limit: z.coerce.number().min(1).max(200).default(50)
  });

  app.get('/behavior/config', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
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
    const user = (req as AuthenticatedRequest).user;
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
    } catch (e: unknown) {
      await client.query('ROLLBACK');
      const error = e as Error;
      req.log.error({ error: 'behavior config save failed', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Behavior config save failed' });
    } finally {
      client.release();
    }
  });

  app.get('/behavior/events', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
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
    const user = (req as AuthenticatedRequest).user;
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
  // ... existing code ...

  const createPledgeSchema = z.object({
    type: z.enum(['iron_contract', 'public_vow', 'momentum']),
    goalType: z.enum(['log_streak', 'workout_frequency', 'no_sugar', 'sleep_early', 'habit_log']),
    stakeAmount: z.number().min(0),
    targetValue: z.number().min(1),
    startDate: z.string().datetime().optional(), // ISO string
    metadata: z.record(z.string(), z.unknown()).optional()
  });

  const resolvePledgeSchema = z.object({
    result: z.enum(['success', 'failed'])
  });

  app.post('/behavior/pledges', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = createPledgeSchema.parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO user_pledges(user_id, type, goal_type, stake_amount, target_value, current_value, start_date, status, metadata)
       VALUES($1, $2, $3, $4, $5, 0, COALESCE($6, now()), 'active', $7)
       RETURNING *`,
      [
        user.userId,
        body.type,
        body.goalType,
        body.stakeAmount,
        body.targetValue,
        body.startDate || null,
        body.metadata ? JSON.stringify(body.metadata) : '{}'
      ]
    );

    // Initial log?
    return reply.send(rows[0]);
  });

  app.get('/behavior/pledges/active', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(
      `SELECT * FROM user_pledges 
       WHERE user_id = $1 AND status = 'active'
       ORDER BY start_date DESC`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      type: r.type,
      goalType: r.goal_type,
      stakeAmount: r.stake_amount,
      targetValue: r.target_value,
      currentValue: r.current_value,
      startDate: r.start_date,
      status: r.status,
      metadata: r.metadata,
      contractAddress: r.contract_address
    }));
  });

  app.post('/behavior/pledges/:id/resolve', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params as { id: string };
    const body = resolvePledgeSchema.parse(req.body);

    const { rows } = await pool.query(
      `UPDATE user_pledges
       SET status = $1, end_date = now()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [body.result, id, user.userId]
    );

    if (rows.length === 0) return reply.status(404).send({ error: 'Pledge not found' });

    return reply.send(rows[0]);
  });
}


