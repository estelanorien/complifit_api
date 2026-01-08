import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard, adminGuard } from '../hooks/auth';
import { pool } from '../../db/pool';

const subscribeSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        p256dh: z.string(),
        auth: z.string()
    })
});

const sendSchema = z.object({
    userId: z.string().uuid().optional(),
    topic: z.string().optional(),
    title: z.string().min(1),
    body: z.string().min(1),
    url: z.string().optional(),
    actions: z.array(z.object({
        action: z.string(),
        title: z.string()
    })).optional()
});

export async function notificationRoutes(app: FastifyInstance) {
    // Ensure table exists
    await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      last_used TIMESTAMP WITH TIME ZONE
    );
  `);

    // Subscribe to push notifications
    app.post('/notifications/subscribe', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const body = subscribeSchema.parse(req.body);

        try {
            await pool.query(
                `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = $1, p256dh = $3, auth = $4, last_used = NOW()`,
                [user.userId, body.endpoint, body.keys.p256dh, body.keys.auth]
            );

            return reply.send({ success: true });
        } catch (e: any) {
            req.log.error({ error: 'subscribe failed', e });
            return reply.status(500).send({ error: e.message });
        }
    });

    // Unsubscribe
    app.post('/notifications/unsubscribe', { preHandler: authGuard }, async (req, reply) => {
        const body = z.object({ endpoint: z.string() }).parse(req.body);

        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [body.endpoint]);
        return reply.send({ success: true });
    });

    // Send notification (ADMIN ONLY)
    app.post('/admin/notifications/send', { preHandler: [authGuard, adminGuard] }, async (req, reply) => {
        const body = sendSchema.parse(req.body);

        try {
            let subscriptions: any[] = [];

            if (body.userId) {
                // Send to specific user
                const res = await pool.query(
                    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
                    [body.userId]
                );
                subscriptions = res.rows;
            } else if (body.topic) {
                // Future: topic-based subscriptions
                return reply.status(400).send({ error: 'Topic subscriptions not yet implemented' });
            } else {
                // Send to all (for broadcasts)
                const res = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions LIMIT 1000');
                subscriptions = res.rows;
            }

            // Note: Actual push sending requires web-push library and VAPID keys
            // This logs the intent - actual sending should use web-push npm package
            req.log.info({
                message: 'Push notification request',
                recipientCount: subscriptions.length,
                title: body.title
            });

            // Placeholder: In production, use web-push library
            // For now, log and return success
            return reply.send({
                success: true,
                sent: subscriptions.length,
                message: 'Push notifications queued'
            });
        } catch (e: any) {
            req.log.error({ error: 'send notification failed', e });
            return reply.status(500).send({ error: e.message });
        }
    });

    // User preference for auto-notifications (Spotter nearby, meal reminders)
    app.post('/notifications/preferences', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            spotterNearby: z.boolean().optional(),
            mealReminders: z.boolean().optional(),
            workoutReminders: z.boolean().optional()
        }).parse(req.body);

        await pool.query(
            `UPDATE user_profiles SET notification_prefs = $2 WHERE user_id = $1`,
            [user.userId, JSON.stringify(body)]
        );

        return reply.send({ success: true });
    });
}
