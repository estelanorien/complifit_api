import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard, adminGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

const reportSchema = z.object({
  targetId: z.string(),
  type: z.enum(['post', 'message', 'user']),
  reason: z.string().optional(),
  comment: z.string().optional(),
  content: z.any().optional()
});

const resolveSchema = z.object({
  itemId: z.string(),
  action: z.string(),
  aiAnalysis: z.string().optional()
});

export async function moderationRoutes(app: FastifyInstance) {
  app.post('/moderation/report', { preHandler: authGuard }, async (req, reply) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const body = reportSchema.parse(req.body);
      await pool.query(
        `INSERT INTO moderation_queue(id, target_id, target_type, reason, reporter_comment, reporter_id, content, status, timestamp)
         VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', now())`,
        [body.targetId, body.type, body.reason || null, body.comment || null, user.userId, body.content || {}]
      );
      return reply.send({ success: true });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log?.error(e);
      return reply.status(500).send({ error: isProduction ? 'Report submission service unavailable' : (error.message || 'Report submission failed') });
    }
  });

  app.get('/moderation/queue', { preHandler: adminGuard }, async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, target_id as "targetId", target_type as "targetType", reason, reporter_comment as "reporterComment",
                reporter_id as "reporterId", content, status, timestamp, resolution_action as "resolutionAction", ai_analysis as "aiAnalysis"
         FROM moderation_queue WHERE status = 'pending' ORDER BY timestamp DESC`
      );
      return rows;
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log?.error(e);
      return reply.status(500).send({ error: isProduction ? 'Queue fetch service unavailable' : (error.message || 'Queue fetch failed') });
    }
  });

  app.get('/moderation/history', { preHandler: adminGuard }, async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, target_id as "targetId", target_type as "targetType", reason, reporter_comment as "reporterComment",
                reporter_id as "reporterId", content, status, timestamp, resolution_action as "resolutionAction", ai_analysis as "aiAnalysis"
         FROM moderation_queue WHERE status <> 'pending' ORDER BY timestamp DESC LIMIT 50`
      );
      return rows;
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log?.error(e);
      return reply.status(500).send({ error: isProduction ? 'History fetch service unavailable' : (error.message || 'History fetch failed') });
    }
  });

  app.post('/moderation/resolve', { preHandler: adminGuard }, async (req, reply) => {
    try {
      const body = resolveSchema.parse(req.body);
      await pool.query(
        `UPDATE moderation_queue SET status='resolved', resolution_action=$1, ai_analysis=$2 WHERE id=$3`,
        [body.action, body.aiAnalysis || null, body.itemId]
      );
      return reply.send({ success: true });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log?.error(e);
      return reply.status(500).send({ error: isProduction ? 'Resolution service unavailable' : (error.message || 'Resolution failed') });
    }
  });
}

