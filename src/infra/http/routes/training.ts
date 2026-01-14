import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import { TrainingPlan, generateTrainingPlan } from '../../../application/services/trainingService';
import { saveTrainingProgram } from './_utils/saveTrainingPlan';

export async function trainingRoutes(app: FastifyInstance) {
  const generateSchema = z.object({
    profile: z.any(),
    metrics: z.any().optional(),
    duration: z.number().min(1).max(30).default(7),
    lang: z.string().default('en'),
    varietyMode: z.string().optional(),
    previousPlan: z.any().optional(),
    varietyInput: z.string().optional(),
    overrideStyle: z.string().optional(),
    history: z.array(z.any()).optional(),
    startDate: z.string().optional()
  });

  app.post('/training/generate', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = generateSchema.parse(req.body);
    try {
      const trainingPlan = await generateTrainingPlan({
        profile: body.profile,
        metrics: body.metrics,
        duration: body.duration,
        lang: body.lang,
        varietyMode: body.varietyMode,
        previousPlan: body.previousPlan,
        varietyInput: body.varietyInput,
        overrideStyle: body.overrideStyle,
        history: body.history
      });
      if (!Array.isArray(trainingPlan?.schedule) || trainingPlan.schedule.length === 0) {
        return reply.status(500).send({ error: 'Training plan empty from Gemini' });
      }

      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
        await client.query('BEGIN');
        const trainingId = await saveTrainingProgram(client, user.userId, trainingPlan, body.startDate);
        await client.query('COMMIT');
        return reply.send({ training: trainingPlan, trainingId });
      } catch (e: any) {
        await client.query('ROLLBACK');
        req.log.error({ error: 'training generate save failed', e, requestId: (req as any).requestId });
        return reply.status(500).send({ error: e.message || 'Training save failed' });
      } finally {
        client.release();
      }
    } catch (e: any) {
      req.log.error({ error: 'Training generate failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Training generate failed' });
    }
  });

  const archiveSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string(),
    program: z.any(),
    dateCreated: z.string().optional()
  });

  app.get('/training/archive', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, name, program, date_created
       FROM saved_training_programs
       WHERE user_id = $1
       ORDER BY date_created DESC
       LIMIT 100`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      timestampLabel: new Date(r.date_created).toLocaleDateString(),
      program: r.program
    }));
  });

  app.post('/training/archive', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const body = archiveSchema.parse(req.body);
    if (body.id) {
      await pool.query(
        `UPDATE saved_training_programs
         SET name = $1,
             program = $2,
             date_created = COALESCE($3, date_created)
         WHERE id = $4 AND user_id = $5`,
        [body.name, body.program, body.dateCreated ? new Date(body.dateCreated) : null, body.id, user.userId]
      );
      return { id: body.id };
    }
    const { rows } = await pool.query(
      `INSERT INTO saved_training_programs(user_id, name, program, date_created)
       VALUES($1,$2,$3,COALESCE($4, now()))
       RETURNING id`,
      [user.userId, body.name, body.program, body.dateCreated ? new Date(body.dateCreated) : null]
    );
    return { id: rows[0].id };
  });

  app.delete('/training/archive/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await pool.query(
      `DELETE FROM saved_training_programs WHERE id = $1 AND user_id = $2`,
      [id, user.userId]
    );
    return reply.code(204).send();
  });

  // Archives
  app.get('/training/archives', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, name, date_created, program, progress_day_index
       FROM training_archives
       WHERE user_id = $1
       ORDER BY date_created DESC`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      timestampLabel: new Date(r.date_created).toLocaleDateString(),
      program: r.program,
      progressDayIndex: r.progress_day_index ?? undefined
    }));
  });

  const saveArchiveSchema = z.object({
    name: z.string(),
    program: z.any(),
    progressDayIndex: z.number().optional(),
    summary: z.string().optional()
  });

  app.post('/training/archives', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = saveArchiveSchema.parse(req.body);
    const archiveId = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await pool.query(
      `INSERT INTO training_archives(id, user_id, name, program, progress_day_index, summary)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        archiveId,
        user.userId,
        body.name,
        JSON.stringify(body.program),
        body.progressDayIndex ?? null,
        body.summary || null
      ]
    );
    return reply.send({ id: archiveId });
  });

  const loadArchiveSchema = z.object({
    id: z.string().uuid(),
    startDate: z.string().optional()
  });

  app.post('/training/archives/load', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = loadArchiveSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT program FROM training_archives WHERE id = $1 AND user_id = $2`,
      [body.id, user.userId]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Archive not found' });
    const plan = rows[0].program as TrainingPlan;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await saveTrainingProgram(client, user.userId, plan, body.startDate, { isRecovery: !!plan?.isRecovery });
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (e: any) {
      await client.query('ROLLBACK');
      req.log.error({ error: 'training archive load failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Archive load failed' });
    } finally {
      client.release();
    }
  });

  app.delete('/training/archives/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const res = await pool.query(`DELETE FROM training_archives WHERE id = $1 AND user_id = $2`, [id, user.userId]);
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });

  app.patch('/training/archives/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const body = z.object({ name: z.string() }).parse(req.body);
    const res = await pool.query(
      `UPDATE training_archives SET name = $1 WHERE id = $2 AND user_id = $3`,
      [body.name, id, user.userId]
    );
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });

  // Alias routes for backward compatibility (/archives/training → /training/archives)
  app.get('/archives/training', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, name, date_created, program, progress_day_index
       FROM training_archives
       WHERE user_id = $1
       ORDER BY date_created DESC`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      timestampLabel: new Date(r.date_created).toLocaleDateString(),
      program: r.program,
      progressDayIndex: r.progress_day_index ?? undefined
    }));
  });

  app.post('/archives/training', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = saveArchiveSchema.parse(req.body);
    const archiveId = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await pool.query(
      `INSERT INTO training_archives(id, user_id, name, program, progress_day_index, summary)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        archiveId,
        user.userId,
        body.name,
        JSON.stringify(body.program),
        body.progressDayIndex ?? null,
        body.summary || null
      ]
    );
    return reply.send({ id: archiveId });
  });

  app.delete('/archives/training/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const res = await pool.query(`DELETE FROM training_archives WHERE id = $1 AND user_id = $2`, [id, user.userId]);
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });

  app.patch('/archives/training/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const body = z.object({ name: z.string() }).parse(req.body);
    const res = await pool.query(
      `UPDATE training_archives SET name = $1 WHERE id = $2 AND user_id = $3`,
      [body.name, id, user.userId]
    );
    if (res.rowCount === 0) return reply.status(404).send({ error: 'Archive not found' });
    return reply.send({ success: true });
  });

  app.get('/archives/training/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const id = z.string().uuid().parse((req.params as any).id);
    const { rows } = await pool.query(
      `SELECT id, name, date_created, program, progress_day_index, summary
       FROM training_archives
       WHERE id = $1 AND user_id = $2`,
      [id, user.userId]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Archive not found' });
    const r = rows[0];
    return reply.send({
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      program: r.program,
      progressDayIndex: r.progress_day_index ?? undefined,
      summary: r.summary
    });
  });
}


