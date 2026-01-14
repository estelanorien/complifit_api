import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';

const systemMsgSchema = z.object({
  title: z.string().default('Notification'),
  content: z.string(),
  type: z.enum(['system', 'coach_update', 'community_alert']).default('system'),
  priority: z.enum(['high', 'low']).optional(),
  payload: z.any().optional()
});

export async function messagesRoutes(app: FastifyInstance) {
  // System messages for current user
  app.get('/messages/system', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, title, content, type, priority, read, timestamp, payload
       FROM system_messages
       WHERE user_id IS NULL OR user_id = $1
       ORDER BY timestamp DESC
       LIMIT 50`,
      [user.userId]
    );
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      content: r.content,
      type: r.type,
      priority: r.priority,
      read: r.read,
      timestamp: r.timestamp,
      payload: r.payload
    }));
  });

  // Create system message (optionally user-scoped)
  app.post('/messages/system', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = systemMsgSchema.parse(req.body);
    const idRes = await pool.query('SELECT gen_random_uuid() as id');
    const id = idRes.rows[0].id;
    await pool.query(
      `INSERT INTO system_messages(id, user_id, title, content, type, priority, read, timestamp, payload)
       VALUES($1, $2, $3, $4, $5, $6, false, now(), $7)`,
      [id, user.userId, body.title, body.content, body.type, body.priority || 'low', body.payload || {}]
    );
    return reply.send({ id });
  });
}

