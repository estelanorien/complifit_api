import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { authGuard } from '../hooks/auth.js';
import { invalidateTierCache } from '../hooks/proGuard.js';
import { AuthenticatedRequest } from '../types.js';
import { env } from '../../../config/env.js';

// UUID v4 pattern for validating user IDs
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function subscriptionRoutes(app: FastifyInstance) {
    // 1. Upgrade to Pro — disabled in production (requires native app store purchase)
    app.post('/subscription/upgrade', { preHandler: authGuard }, async (req, reply) => {
        const isProduction = env.revenueCat.apiKey && env.revenueCat.apiKey !== '';

        if (isProduction) {
            return reply.status(403).send({
                error: 'Direct upgrade not available',
                message: 'Please subscribe through the mobile app (iOS/Android).'
            });
        }

        // Development/testing only — no payment processor configured
        const user = (req as AuthenticatedRequest).user;

        await pool.query(
            `UPDATE profiles
             SET subscription_tier = 'pro',
                 subscription_status = 'active',
                 subscription_expiry = NOW() + INTERVAL '30 days'
             WHERE user_id = $1`,
            [user.userId]
        );

        invalidateTierCache(user.userId);

        return { success: true, message: 'Welcome to Complifit Pro! (dev mode)', tier: 'pro' };
    });

    // 2. Downgrade/Cancel (Mock / Web fallback)
    app.post('/subscription/cancel', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;

        await pool.query(
            `UPDATE profiles
             SET subscription_tier = 'free',
                 subscription_status = 'cancelled'
             WHERE user_id = $1`,
            [user.userId]
        );

        invalidateTierCache(user.userId);

        return { success: true, message: 'Subscription cancelled.', tier: 'free' };
    });

    // 3. Get subscription status
    app.get('/subscription/status', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;

        const { rows } = await pool.query(
            `SELECT subscription_tier, subscription_status, subscription_expiry
             FROM profiles WHERE user_id = $1`,
            [user.userId]
        );

        const profile = rows[0];
        if (!profile) {
            return { tier: 'free', status: 'none', expiry: null };
        }

        return {
            tier: profile.subscription_tier || 'free',
            status: profile.subscription_status || 'none',
            expiry: profile.subscription_expiry || null
        };
    });

    // 4. Verify subscription via RevenueCat REST API
    app.post('/subscription/verify', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const apiKey = env.revenueCat.apiKey;

        if (!apiKey) {
            req.log.warn('REVENUECAT_API_KEY not configured, skipping verification');
            return { verified: false, message: 'Subscription verification not configured' };
        }

        try {
            const res = await fetch(
                `https://api.revenuecat.com/v1/subscribers/${user.userId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!res.ok) {
                req.log.error({ status: res.status, message: 'RevenueCat API error' });
                return reply.status(502).send({ error: 'Subscription service unavailable' });
            }

            const data: any = await res.json();
            const entitlements = data?.subscriber?.entitlements || {};
            const proEntitlement = entitlements['pro'];

            let tier = 'free';
            let status = 'none';
            let expiry: string | null = null;

            if (proEntitlement) {
                expiry = proEntitlement.expires_date || null;
                const now = new Date();
                const expiryDate = expiry ? new Date(expiry) : null;

                if (expiryDate && expiryDate > now) {
                    tier = 'pro';
                    status = proEntitlement.unsubscribe_detected_at ? 'cancelled' : 'active';
                } else {
                    tier = 'free';
                    status = 'expired';
                }
            }

            await pool.query(
                `UPDATE profiles
                 SET subscription_tier = $1,
                     subscription_status = $2,
                     subscription_expiry = $3
                 WHERE user_id = $4`,
                [tier, status, expiry, user.userId]
            );

            invalidateTierCache(user.userId);

            return { verified: true, tier, status, expiry };
        } catch (e: unknown) {
            const error = e as Error;
            req.log.error({ error: 'RevenueCat verify failed', message: error.message });
            return reply.status(500).send({ error: 'Verification failed' });
        }
    });

    // 5. RevenueCat S2S Webhook
    app.post('/subscription/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
        // Verify webhook auth token — ALWAYS required, fail-safe if not configured
        const webhookAuth = env.revenueCat.webhookAuth;
        if (!webhookAuth) {
            req.log.error('REVENUECAT_WEBHOOK_AUTH not configured — rejecting webhook');
            return reply.status(503).send({ error: 'Webhook not configured' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${webhookAuth}`) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        try {
            const body = req.body as any;
            const event = body?.event;

            if (!event) {
                return reply.status(400).send({ error: 'Missing event' });
            }

            const eventType: string = event.type || '';
            const appUserId: string = event.app_user_id || '';
            const expiresDate: string | null = event.expiration_at_ms
                ? new Date(event.expiration_at_ms).toISOString()
                : null;

            if (!appUserId) {
                req.log.warn({ eventType, message: 'Webhook event missing app_user_id' });
                return reply.status(400).send({ error: 'Missing app_user_id' });
            }

            // Validate app_user_id is a valid UUID to prevent injection
            if (!UUID_REGEX.test(appUserId)) {
                req.log.warn({ eventType, appUserId, message: 'Webhook event has invalid app_user_id format' });
                return reply.status(400).send({ error: 'Invalid app_user_id format' });
            }

            let tier = 'free';
            let status = 'none';

            switch (eventType) {
                case 'INITIAL_PURCHASE':
                case 'RENEWAL':
                case 'UNCANCELLATION':
                    tier = 'pro';
                    status = 'active';
                    break;
                case 'CANCELLATION':
                    tier = 'pro';
                    status = 'cancelled';
                    break;
                case 'EXPIRATION':
                case 'BILLING_ISSUE_DETECTED':
                    tier = 'free';
                    status = 'expired';
                    break;
                default:
                    req.log.info({ eventType, appUserId, message: 'Unhandled webhook event type' });
                    return { received: true };
            }

            await pool.query(
                `UPDATE profiles
                 SET subscription_tier = $1,
                     subscription_status = $2,
                     subscription_expiry = $3
                 WHERE user_id = $4`,
                [tier, status, expiresDate, appUserId]
            );

            invalidateTierCache(appUserId);

            req.log.info({ eventType, appUserId, tier, status, message: 'Webhook processed' });
            return { received: true };
        } catch (e: unknown) {
            const error = e as Error;
            req.log.error({ error: 'Webhook processing failed', message: error.message });
            return reply.status(500).send({ error: 'Webhook processing failed' });
        }
    });
}
