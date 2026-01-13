import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard, adminGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import { env } from '../../../config/env';
import webpush from 'web-push';

// Configure web-push with VAPID keys if available
if (env.vapid.publicKey && env.vapid.privateKey && env.vapid.email) {
    webpush.setVapidDetails(
        `mailto:${env.vapid.email}`,
        env.vapid.publicKey,
        env.vapid.privateKey
    );
}

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
    icon: z.string().optional(),
    actions: z.array(z.object({
        action: z.string(),
        title: z.string()
    })).optional()
});

export async function notificationRoutes(app: FastifyInstance) {
    // Get VAPID public key for frontend subscription
    app.get('/notifications/vapid-public-key', async (req, reply) => {
        if (!env.vapid.publicKey) {
            return reply.status(503).send({ error: 'Push notifications not configured' });
        }
        return { publicKey: env.vapid.publicKey };
    });

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

        // Check if VAPID is configured
        if (!env.vapid.publicKey || !env.vapid.privateKey) {
            return reply.status(503).send({
                error: 'Push notifications not configured. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_EMAIL environment variables.'
            });
        }

        try {
            let subscriptions: any[] = [];

            if (body.userId) {
                // Send to specific user
                const res = await pool.query(
                    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
                    [body.userId]
                );
                subscriptions = res.rows;
            } else if (body.topic) {
                // Future: topic-based subscriptions
                return reply.status(400).send({ error: 'Topic subscriptions not yet implemented' });
            } else {
                // Send to all (for broadcasts)
                const res = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions LIMIT 1000');
                subscriptions = res.rows;
            }

            const payload = JSON.stringify({
                title: body.title,
                body: body.body,
                url: body.url,
                icon: body.icon || '/icons/icon-192x192.png',
                actions: body.actions
            });

            let successCount = 0;
            let failCount = 0;
            const failedSubscriptionIds: string[] = [];

            // Send to all subscriptions
            await Promise.all(subscriptions.map(async (sub) => {
                try {
                    await webpush.sendNotification(
                        {
                            endpoint: sub.endpoint,
                            keys: {
                                p256dh: sub.p256dh,
                                auth: sub.auth
                            }
                        },
                        payload
                    );
                    successCount++;

                    // Update last_used timestamp
                    await pool.query(
                        'UPDATE push_subscriptions SET last_used = NOW() WHERE id = $1',
                        [sub.id]
                    );
                } catch (err: any) {
                    failCount++;
                    req.log.warn({
                        error: 'Push send failed',
                        endpoint: sub.endpoint.substring(0, 50),
                        statusCode: err.statusCode
                    });

                    // If subscription is invalid (410 Gone or 404), mark for deletion
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        failedSubscriptionIds.push(sub.id);
                    }
                }
            }));

            // Clean up invalid subscriptions
            if (failedSubscriptionIds.length > 0) {
                await pool.query(
                    'DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])',
                    [failedSubscriptionIds]
                );
                req.log.info({ message: 'Cleaned up invalid subscriptions', count: failedSubscriptionIds.length });
            }

            req.log.info({
                message: 'Push notifications sent',
                total: subscriptions.length,
                success: successCount,
                failed: failCount
            });

            return reply.send({
                success: true,
                sent: successCount,
                failed: failCount,
                cleaned: failedSubscriptionIds.length
            });
        } catch (e: any) {
            req.log.error({ error: 'send notification failed', e });
            return reply.status(500).send({ error: e.message });
        }
    });

    // User preference for auto-notifications
    app.post('/notifications/preferences', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            spotterNearby: z.boolean().optional(),
            mealReminders: z.boolean().optional(),
            workoutReminders: z.boolean().optional(),
            dailyTips: z.boolean().optional(),
            weeklyProgress: z.boolean().optional()
        }).parse(req.body);

        await pool.query(
            `UPDATE user_profiles SET notification_prefs = $2 WHERE user_id = $1`,
            [user.userId, JSON.stringify(body)]
        );

        return reply.send({ success: true });
    });

    // Get user's notification preferences
    app.get('/notifications/preferences', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;

        const res = await pool.query(
            'SELECT notification_prefs FROM user_profiles WHERE user_id = $1',
            [user.userId]
        );

        return { preferences: res.rows[0]?.notification_prefs || {} };
    });
}
