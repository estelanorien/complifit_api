import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard, adminGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { env } from '../../../config/env.js';
import webpush from 'web-push';
import { sendFcmNotification, sendFcmNotificationBatch, isFirebaseInitialized } from '../../../services/firebaseService.js';
import { AuthenticatedRequest } from '../types.js';

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
        const user = (req as AuthenticatedRequest).user;
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
        } catch (e: unknown) {
            const error = e as Error;
            req.log.error({ error: 'subscribe failed', message: error.message });
            return reply.status(500).send({ error: error.message });
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
                const subRes = await pool.query(
                    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
                    [body.userId]
                );
                subscriptions = subRes.rows;

                const tokenRes = await pool.query(
                    'SELECT fcm_token FROM user_profiles WHERE user_id = $1',
                    [body.userId]
                );
                const fcmToken = tokenRes.rows[0]?.fcm_token;
                if (fcmToken && isFirebaseInitialized()) {
                    req.log.info({ message: 'Sending FCM notification to user', userId: body.userId, token: fcmToken.substring(0, 10) + '...' });
                    const fcmResult = await sendFcmNotification(
                        fcmToken,
                        body.title,
                        body.body,
                        body.url ? { url: body.url } : undefined,
                        {
                            icon: body.icon,
                            url: body.url,
                            actions: body.actions
                        }
                    );
                    if (!fcmResult.success) {
                        req.log.warn({ message: 'FCM send failed', error: fcmResult.error, userId: body.userId });
                    }
                }
            } else if (body.topic) {
                // Future: topic-based subscriptions
                return reply.status(400).send({ error: 'Topic subscriptions not yet implemented' });
            } else {
                // Send to all (for broadcasts)
                const subRes = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions LIMIT 1000');
                subscriptions = subRes.rows;

                const tokenRes = await pool.query('SELECT user_id, fcm_token FROM user_profiles WHERE fcm_token IS NOT NULL LIMIT 1000');
                const fcmTokens = tokenRes.rows.map(r => r.fcm_token).filter(Boolean);
                if (fcmTokens.length > 0 && isFirebaseInitialized()) {
                    req.log.info({ message: 'Sending FCM broadcast', count: fcmTokens.length });
                    const fcmResult = await sendFcmNotificationBatch(
                        fcmTokens,
                        body.title,
                        body.body,
                        body.url ? { url: body.url } : undefined,
                        {
                            icon: body.icon,
                            url: body.url,
                            actions: body.actions
                        }
                    );
                    req.log.info({
                        message: 'FCM broadcast result',
                        success: fcmResult.successCount,
                        failed: fcmResult.failureCount,
                        invalidTokens: fcmResult.invalidTokens.length
                    });
                } else {
                    req.log.info({ message: 'Found FCM tokens for broadcast but Firebase not initialized', count: fcmTokens.length });
                }
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
                } catch (err: unknown) {
                    failCount++;
                    const pushError = err as { statusCode?: number; message?: string };
                    req.log.warn({
                        error: 'Push send failed',
                        endpoint: sub.endpoint.substring(0, 50),
                        statusCode: pushError.statusCode
                    });

                    // If subscription is invalid (410 Gone or 404), mark for deletion
                    if (pushError.statusCode === 410 || pushError.statusCode === 404) {
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
        } catch (e: unknown) {
            const error = e as Error;
            req.log.error({ error: 'send notification failed', message: error.message });
            return reply.status(500).send({ error: error.message });
        }
    });

    // User preference for auto-notifications
    app.post('/notifications/preferences', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
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
        const user = (req as AuthenticatedRequest).user;

        const res = await pool.query(
            'SELECT notification_prefs FROM user_profiles WHERE user_id = $1',
            [user.userId]
        );

        return { preferences: res.rows[0]?.notification_prefs || {} };
    });
}
