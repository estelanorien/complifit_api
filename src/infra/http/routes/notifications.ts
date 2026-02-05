import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard, adminGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { env } from '../../../config/env.js';
import webpush from 'web-push';
import {
    initializeFirebase,
    isFirebaseInitialized,
    sendFcmNotification,
    sendFcmNotificationBatch,
    subscribeToTopic,
    unsubscribeFromTopic,
    sendToTopic
} from '../../../services/firebaseService.js';

// Initialize Firebase on module load
initializeFirebase();

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
                const subRes = await pool.query(
                    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
                    [body.userId]
                );
                subscriptions = subRes.rows;

                // Also send via FCM for mobile devices
                const tokenRes = await pool.query(
                    'SELECT fcm_token FROM user_profiles WHERE user_id = $1',
                    [body.userId]
                );
                const fcmToken = tokenRes.rows[0]?.fcm_token;
                if (fcmToken && isFirebaseInitialized()) {
                    req.log.info({ message: 'Sending FCM notification to user', userId: body.userId });
                    const fcmResult = await sendFcmNotification(
                        fcmToken,
                        body.title,
                        body.body,
                        undefined,
                        { icon: body.icon, url: body.url, actions: body.actions }
                    );
                    if (fcmResult.success) {
                        req.log.info({ message: 'FCM notification sent', messageId: fcmResult.messageId });
                    } else {
                        req.log.warn({ message: 'FCM notification failed', error: fcmResult.error });
                        // If token is invalid, clear it from the database
                        if (fcmResult.error === 'TOKEN_INVALID') {
                            await pool.query(
                                'UPDATE user_profiles SET fcm_token = NULL WHERE user_id = $1',
                                [body.userId]
                            );
                            req.log.info({ message: 'Cleared invalid FCM token for user', userId: body.userId });
                        }
                    }
                }
            } else if (body.topic) {
                // Send to FCM topic
                if (isFirebaseInitialized()) {
                    const topicResult = await sendToTopic(
                        body.topic,
                        body.title,
                        body.body,
                        { url: body.url || '', icon: body.icon || '' }
                    );
                    if (topicResult.success) {
                        return reply.send({
                            success: true,
                            sent: 1,
                            failed: 0,
                            messageId: topicResult.messageId,
                            type: 'topic'
                        });
                    } else {
                        return reply.status(500).send({ error: topicResult.error });
                    }
                } else {
                    return reply.status(503).send({ error: 'Firebase not initialized. Cannot send to topic.' });
                }
            } else {
                // Send to all (for broadcasts)
                const subRes = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions LIMIT 1000');
                subscriptions = subRes.rows;

                // Also broadcast via FCM
                const tokenRes = await pool.query('SELECT user_id, fcm_token FROM user_profiles WHERE fcm_token IS NOT NULL LIMIT 1000');
                req.log.info({ message: 'Found FCM tokens for broadcast', count: tokenRes.rows.length });

                if (tokenRes.rows.length > 0 && isFirebaseInitialized()) {
                    const fcmTokens = tokenRes.rows.map(r => r.fcm_token);
                    const fcmResult = await sendFcmNotificationBatch(
                        fcmTokens,
                        body.title,
                        body.body,
                        undefined,
                        { icon: body.icon, url: body.url, actions: body.actions }
                    );
                    req.log.info({
                        message: 'FCM broadcast results',
                        success: fcmResult.successCount,
                        failed: fcmResult.failureCount,
                        invalidTokens: fcmResult.invalidTokens.length
                    });

                    // Clear invalid tokens
                    if (fcmResult.invalidTokens.length > 0) {
                        const userIdsToUpdate = tokenRes.rows
                            .filter(r => fcmResult.invalidTokens.includes(r.fcm_token))
                            .map(r => r.user_id);
                        if (userIdsToUpdate.length > 0) {
                            await pool.query(
                                'UPDATE user_profiles SET fcm_token = NULL WHERE user_id = ANY($1::uuid[])',
                                [userIdsToUpdate]
                            );
                            req.log.info({ message: 'Cleared invalid FCM tokens', count: userIdsToUpdate.length });
                        }
                    }
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

    // Subscribe to a topic (FCM)
    app.post('/notifications/topics/subscribe', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            topic: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid topic name')
        }).parse(req.body);

        if (!isFirebaseInitialized()) {
            return reply.status(503).send({ error: 'Firebase not initialized' });
        }

        // Get user's FCM token
        const tokenRes = await pool.query(
            'SELECT fcm_token FROM user_profiles WHERE user_id = $1',
            [user.userId]
        );
        const fcmToken = tokenRes.rows[0]?.fcm_token;

        if (!fcmToken) {
            return reply.status(400).send({ error: 'No FCM token registered for this user' });
        }

        const result = await subscribeToTopic([fcmToken], body.topic);

        if (result.successCount > 0) {
            // Store topic subscription in database for tracking
            await pool.query(
                `INSERT INTO user_topic_subscriptions (user_id, topic)
                 VALUES ($1, $2)
                 ON CONFLICT (user_id, topic) DO NOTHING`,
                [user.userId, body.topic]
            );
            return reply.send({ success: true, topic: body.topic });
        } else {
            return reply.status(500).send({ error: 'Failed to subscribe to topic' });
        }
    });

    // Unsubscribe from a topic (FCM)
    app.post('/notifications/topics/unsubscribe', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            topic: z.string().min(1).max(100)
        }).parse(req.body);

        if (!isFirebaseInitialized()) {
            return reply.status(503).send({ error: 'Firebase not initialized' });
        }

        // Get user's FCM token
        const tokenRes = await pool.query(
            'SELECT fcm_token FROM user_profiles WHERE user_id = $1',
            [user.userId]
        );
        const fcmToken = tokenRes.rows[0]?.fcm_token;

        if (!fcmToken) {
            return reply.status(400).send({ error: 'No FCM token registered for this user' });
        }

        const result = await unsubscribeFromTopic([fcmToken], body.topic);

        // Remove from database regardless of FCM result
        await pool.query(
            'DELETE FROM user_topic_subscriptions WHERE user_id = $1 AND topic = $2',
            [user.userId, body.topic]
        );

        return reply.send({ success: true, topic: body.topic });
    });

    // Get user's topic subscriptions
    app.get('/notifications/topics', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;

        const res = await pool.query(
            'SELECT topic, created_at FROM user_topic_subscriptions WHERE user_id = $1 ORDER BY created_at DESC',
            [user.userId]
        );

        return { topics: res.rows.map(r => r.topic) };
    });

    // Register FCM token for mobile device
    app.post('/notifications/fcm-token', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            token: z.string().min(1)
        }).parse(req.body);

        await pool.query(
            'UPDATE user_profiles SET fcm_token = $2 WHERE user_id = $1',
            [user.userId, body.token]
        );

        return reply.send({ success: true });
    });
}
