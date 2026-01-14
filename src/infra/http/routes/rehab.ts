import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { RehabPlan, generateRehabPlan } from '../../../application/services/rehabService.js';
import { saveTrainingProgram } from './_utils/saveTrainingPlan.js';

export async function rehabRoutes(app: FastifyInstance) {
  const generateSchema = z.object({
    stats: z.object({
      selectedConditions: z.array(z.string()),
      painLevel: z.number(),
      recoveryPhase: z.string(),
      timeSinceEvent: z.string().optional(),
      mobilityStatus: z.string().optional()
    }),
    duration: z.number().min(3).max(30).default(7),
    lang: z.string().default('en')
  });

  app.post('/rehab/generate', { preHandler: authGuard }, async (req, reply) => {
    const body = generateSchema.parse(req.body);
    try {
      const plan = await generateRehabPlan(body);
      return reply.send({ plan });
    } catch (e: any) {
      req.log.error({ error: 'Rehab generate failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Rehab generate failed' });
    }
  });

  const applySchema = z.object({
    plan: z.any(),
    startDate: z.string().optional()
  });

  app.post('/rehab/apply', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = applySchema.parse(req.body);
    const plan = body.plan as RehabPlan;
    if (!plan || !Array.isArray(plan.schedule) || plan.schedule.length === 0) {
      return reply.status(400).send({ error: 'Invalid rehab plan' });
    }
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      await saveTrainingProgram(client, user.userId, { ...plan, trainingStyle: 'rehab' }, body.startDate, { isRecovery: true });
      await client.query(
        `INSERT INTO training_archives(id, user_id, name, program, progress_day_index, summary)
         VALUES(gen_random_uuid(), $1, $2, $3, NULL, $4)`,
        [
          user.userId,
          plan.name || 'Recovery Protocol',
          JSON.stringify(plan),
          'Auto-saved rehab protocol'
        ]
      );
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'Rehab apply failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Rehab apply failed' });
    } finally {
      client.release();
    }
  });

  const painLogSchema = z.object({
    painLevel: z.number().min(0).max(10),
    mobilityStatus: z.string().optional(),
    recoveryPhase: z.string().optional(),
    notes: z.string().optional()
  });

  app.get('/rehab/pain-logs', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, pain_level, mobility_status, recovery_phase, notes, created_at
       FROM pain_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      painLevel: r.pain_level,
      mobilityStatus: r.mobility_status || undefined,
      recoveryPhase: r.recovery_phase || undefined,
      notes: r.notes || undefined,
      createdAt: r.created_at
    }));
  });

  app.post('/rehab/pain-logs', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = painLogSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO pain_logs(user_id, pain_level, mobility_status, recovery_phase, notes)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id, created_at`,
      [user.userId, body.painLevel, body.mobilityStatus || null, body.recoveryPhase || null, body.notes || null]
    );
    return reply.send({
      id: rows[0].id,
      createdAt: rows[0].created_at
    });
  });
}


