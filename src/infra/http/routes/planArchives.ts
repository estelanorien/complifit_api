import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { withErrorHandler } from './_utils/errorHandler.js';
import { AuthenticatedRequest } from '../types.js';

export async function planArchiveRoutes(app: FastifyInstance) {
    // List archive
    app.get('/plans/archive', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { rows } = await pool.query(
            `SELECT id, name, date_created, training, nutrition, progress_day_index, summary
       FROM saved_smart_plans
       WHERE user_id = $1
       ORDER BY date_created DESC`,
            [user.userId]
        );
        return reply.send(rows);
    }));

    // Save to archive (manual)
    app.post('/plans/archive', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            name: z.string(),
            training: z.unknown(),
            nutrition: z.unknown(),
            progressDayIndex: z.number().optional().default(0),
            summary: z.string().optional()
        }).parse(req.body);

        const { rows } = await pool.query(
            `INSERT INTO saved_smart_plans(user_id, name, training, nutrition, progress_day_index, summary)
       VALUES($1, $2, $3, $4, $5, $6)
       RETURNING id`,
            [user.userId, body.name, body.training, body.nutrition, body.progressDayIndex, body.summary]
        );

        return reply.send({ success: true, id: rows[0].id });
    }));

    // Restore from archive
    app.post('/plans/restore-archived', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id, startDate } = z.object({
            id: z.string().uuid(),
            startDate: z.string().optional().default(new Date().toISOString().split('T')[0])
        }).parse(req.body);

        const { rows } = await pool.query(
            'SELECT id, name, date_created, training, nutrition, progress_day_index, summary FROM saved_smart_plans WHERE id = $1 AND user_id = $2',
            [id, user.userId]
        );

        if (rows.length === 0) {
            return reply.status(404).send({ error: 'Plan not found' });
        }

        const r = rows[0];
        await pool.query(
            `UPDATE user_profiles
       SET profile_data = jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentTrainingProgram}',
           $1::jsonb,
           true
         )
         || jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentMealPlan}',
           $2::jsonb,
           true
         )
         || jsonb_build_object(
           'smartPlanActive', true,
           'trainingProgramStartDate', $3,
           'mealPlanStartDate', $3
         ),
           updated_at = now()
       WHERE user_id = $4`,
            [JSON.stringify(r.training), JSON.stringify(r.nutrition), startDate, user.userId]
        );

        return reply.send({ success: true });
    }));

    // Delete from archive (standard)
    app.delete('/plans/delete-archived', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.body);

        const { rowCount } = await pool.query(
            'DELETE FROM saved_smart_plans WHERE id = $1 AND user_id = $2',
            [id, user.userId]
        );

        if (rowCount === 0) {
            return reply.status(404).send({ error: 'Plan not found or not owned by user' });
        }

        return reply.send({ success: true });
    }));

    // Delete from archive (legacy path param)
    app.delete('/plans/archive/:id', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

        const { rowCount } = await pool.query(
            'DELETE FROM saved_smart_plans WHERE id = $1 AND user_id = $2',
            [id, user.userId]
        );

        if (rowCount === 0) {
            return reply.status(404).send({ error: 'Plan not found or not owned by user' });
        }

        return reply.send({ success: true });
    }));

    // Update archive name
    app.patch('/plans/update-archived-name', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const { id, name } = z.object({
            id: z.string().uuid(),
            name: z.string().min(1)
        }).parse(req.body);

        const { rowCount } = await pool.query(
            'UPDATE saved_smart_plans SET name = $1 WHERE id = $2 AND user_id = $3',
            [name, id, user.userId]
        );

        if (rowCount === 0) {
            return reply.status(404).send({ error: 'Plan not found or not owned by user' });
        }

        return reply.send({ success: true });
    }));
}
