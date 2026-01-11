
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { authGuard } from '../hooks/auth';

export async function subscriptionRoutes(app: FastifyInstance) {
    // 1. Upgrade to Pro (Mock)
    app.post('/subscription/upgrade', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;

        await pool.query(
            `UPDATE profiles 
             SET subscription_tier = 'pro', 
                 subscription_status = 'active',
                 subscription_expiry = NOW() + INTERVAL '30 days'
             WHERE user_id = $1`,
            [user.userId]
        );

        return { success: true, message: 'Welcome to Vitality Pro!', tier: 'pro' };
    });

    // 2. Downgrade/Cancel (Mock)
    app.post('/subscription/cancel', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as any).user;

        await pool.query(
            `UPDATE profiles 
             SET subscription_tier = 'free', 
                 subscription_status = 'cancelled'
             WHERE user_id = $1`,
            [user.userId]
        );

        return { success: true, message: 'Subscription cancelled.', tier: 'free' };
    });
}
