import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';

export async function negotiationRoutes(app: FastifyInstance) {
  const listSchema = z.object({
    status: z.enum(['open', 'accepted', 'declined', 'expired']).optional(),
    limit: z.coerce.number().min(1).max(200).default(50)
  });

  const createSchema = z.object({
    targetType: z.string(),
    targetRef: z.string().uuid().optional(),
    surplusSessionId: z.string().uuid().optional(),
    summary: z.string().optional()
  });

  const actionSchema = z.object({
    actionType: z.string(),
    payload: z.any().optional()
  });

  const updateSchema = z.object({
    status: z.enum(['open', 'accepted', 'declined', 'expired']),
    summary: z.string().optional()
  });

  app.get('/negotiations', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const query = listSchema.parse(req.query ?? {});
    const values: any[] = [user.userId];
    let where = 'user_id = $1';
    let index = 2;

    if (query.status) {
      where += ` AND status = $${index}`;
      values.push(query.status);
      index += 1;
    }

    values.push(query.limit);

    const { rows } = await pool.query(
      `SELECT id, surplus_session_id, target_type, target_ref, status, summary, created_at, resolved_at
       FROM negotiation_sessions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${index}`,
      values
    );

    return rows.map((r: any) => ({
      id: r.id,
      surplusSessionId: r.surplus_session_id,
      targetType: r.target_type,
      targetRef: r.target_ref,
      status: r.status,
      summary: r.summary,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at
    }));
  });

  app.post('/negotiations', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = createSchema.parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO negotiation_sessions(
         id, user_id, surplus_session_id, target_type, target_ref, status, summary, created_at
       )
       VALUES(
         gen_random_uuid(), $1, $2, $3, $4, 'open', $5, now()
       )
       RETURNING id, surplus_session_id, target_type, target_ref, status, summary, created_at`,
      [
        user.userId,
        body.surplusSessionId || null,
        body.targetType,
        body.targetRef || null,
        body.summary || null
      ]
    );

    return reply.send({
      id: rows[0].id,
      surplusSessionId: rows[0].surplus_session_id,
      targetType: rows[0].target_type,
      targetRef: rows[0].target_ref,
      status: rows[0].status,
      summary: rows[0].summary,
      createdAt: rows[0].created_at
    });
  });

  app.post('/negotiations/:id/actions', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = actionSchema.parse(req.body);

    const { rowCount } = await pool.query(
      `SELECT id FROM negotiation_sessions WHERE id = $1 AND user_id = $2`,
      [params.id, user.userId]
    );
    if (rowCount === 0) {
      return reply.status(404).send({ error: 'Negotiation not found' });
    }

    const { rows } = await pool.query(
      `INSERT INTO negotiation_actions(
         id, negotiation_id, action_type, payload, created_at
       )
       VALUES(
         gen_random_uuid(), $1, $2, $3::jsonb, now()
       )
       RETURNING id, action_type, payload, created_at`,
      [
        params.id,
        body.actionType,
        body.payload ? JSON.stringify(body.payload) : null
      ]
    );

    return reply.send({
      id: rows[0].id,
      negotiationId: params.id,
      actionType: rows[0].action_type,
      payload: rows[0].payload,
      createdAt: rows[0].created_at
    });
  });

  app.patch('/negotiations/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = updateSchema.parse(req.body);

    const { rows } = await pool.query(
      `UPDATE negotiation_sessions
       SET status = $1,
           summary = COALESCE($2, summary),
           resolved_at = CASE
             WHEN $1 IN ('accepted', 'declined', 'expired') THEN now()
             ELSE resolved_at
           END
       WHERE id = $3 AND user_id = $4
       RETURNING id, status, summary, created_at, resolved_at`,
      [body.status, body.summary || null, params.id, user.userId]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Negotiation not found' });
    }

    return reply.send({
      id: rows[0].id,
      status: rows[0].status,
      summary: rows[0].summary,
      createdAt: rows[0].created_at,
      resolvedAt: rows[0].resolved_at
    });
  });
}


