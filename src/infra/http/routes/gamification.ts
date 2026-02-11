import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AuthenticatedRequest } from '../types.js';

const actionSchema = z.object({
    action: z.enum([
        'log_meal',
        'log_workout',
        'streak_continue',
        'pay_debt',
        'watch_video',
        'reroll',
        'generate_plan',
        'verify_identity',
        'activate_dojo',
        'log_scan',
        'streak_freeze'
    ]),
    data: z.any().optional() // TODO: define per-action data schema
});

const BADGES_DEFINITIONS = [
    { id: 'b_log_first', key: 'first_log', name: 'Initiate', description: 'Logged your first meal or workout.', icon: 'Flag', tier: 'bronze' },
    { id: 'b_streak_3', key: 'streak_3', name: 'Momentum', description: '3-day streak.', icon: 'Flame', tier: 'bronze' },
    { id: 'b_streak_7', key: 'streak_7', name: 'Unstoppable', description: '7-day streak.', icon: 'Zap', tier: 'silver' },
    { id: 'b_streak_30', key: 'streak_30', name: 'Titan', description: '30-day streak.', icon: 'Crown', tier: 'gold' },
    { id: 'b_early_bird', key: 'early_bird', name: 'Early Bird', description: 'Completed a workout before 7 AM.', icon: 'Sunrise', tier: 'silver' },
    { id: 'b_night_owl', key: 'night_owl', name: 'Night Owl', description: 'Completed a workout after 9 PM.', icon: 'Moon', tier: 'bronze' },
    { id: 'b_debt_free', key: 'debt_free', name: 'The Banker', description: 'Paid off 1000kcal of metabolic debt.', icon: 'Scale', tier: 'silver' },
    { id: 'b_video_watcher', key: 'video_fan', name: 'Director\'s Chair', description: 'Watched 5 AI-generated guides.', icon: 'Clapperboard', tier: 'bronze' },
    { id: 'b_iron_id', key: 'iron_id', name: 'Iron ID', description: 'Verified Identity for Spotter Mode.', icon: 'ShieldCheck', tier: 'gold' },
    { id: 'b_digital_nomad', key: 'digital_nomad', name: 'Virtual Warrior', description: 'Activated Virtual Dojo.', icon: 'Globe', tier: 'silver' },
    { id: 'b_data_scout', key: 'data_scout', name: 'Data Scout', description: 'Contributed a menu scan to the community.', icon: 'Scan', tier: 'silver' }
];

export async function gamificationRoutes(app: FastifyInstance) {
    app.post('/gamification/action', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = actionSchema.parse(req.body);
        const { action, data } = body;

        const client = await pool.connect();
        try {
            await client.query('SET statement_timeout = 10000');
            await client.query('BEGIN');

            // 1. Lock Profile
            const profileRes = await client.query(
                `SELECT profile_data FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
                [user.userId]
            );

            let profileData = profileRes.rows[0]?.profile_data || {};
            let willpowerGain = 0;
            const newBadges = [];
            let message = undefined;

            const currentBadges = new Set((profileData.badges || []).map((b: any) => b.key));

            // 2. Logic (Ported from Frontend)
            switch (action) {
                case 'log_meal': willpowerGain = 1; break;
                case 'log_workout': willpowerGain = 5; break;
                case 'streak_continue': willpowerGain = 2; break;
                case 'pay_debt': willpowerGain = 3; break;
                case 'watch_video': willpowerGain = 1; break;
                case 'verify_identity': willpowerGain = 50; break;
                case 'activate_dojo': willpowerGain = 10; break;
                case 'log_scan': willpowerGain = 5; break;
            }

            // Badge Logic
            if (!currentBadges.has('first_log') && (action === 'log_meal' || action === 'log_workout')) {
                newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'first_log'));
            }

            if (action === 'streak_continue') {
                const streak = (profileData.streak || 0) + 1;
                if (streak >= 3 && !currentBadges.has('streak_3')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'streak_3'));
                if (streak >= 7 && !currentBadges.has('streak_7')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'streak_7'));
                if (streak >= 30 && !currentBadges.has('streak_30')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'streak_30'));
            }

            if (action === 'log_workout' && data?.date) {
                const hour = new Date(data.date).getHours();
                if (hour < 7 && !currentBadges.has('early_bird')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'early_bird'));
                if (hour >= 21 && !currentBadges.has('night_owl')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'night_owl'));
            }

            if (action === 'verify_identity' && !currentBadges.has('iron_id')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'iron_id'));
            if (action === 'activate_dojo' && !currentBadges.has('digital_nomad')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'digital_nomad'));
            if (action === 'log_scan' && !currentBadges.has('data_scout')) newBadges.push(BADGES_DEFINITIONS.find(b => b.key === 'data_scout'));

            // 3. Update State
            profileData.willpower = (profileData.willpower || 0) + willpowerGain;
            if (newBadges.length > 0) {
                profileData.badges = [...(profileData.badges || []), ...newBadges];
            }

            if (action === 'streak_continue') {
                profileData.streak = (profileData.streak || 0) + 1;
            }

            if (action === 'streak_freeze') {
                if (profileData.inventory && profileData.inventory['item_streak_freeze'] > 0) {
                    profileData.inventory['item_streak_freeze']--;
                    message = "Streak Saved!";
                } else {
                    profileData.streak = 0;
                    message = "Streak Reset.";
                }
            }

            // Update Stats
            if (!profileData.stats) profileData.stats = { rerolls: 0, plan_generations: 0, completions: 0 };
            if (action === 'reroll') profileData.stats.rerolls = (profileData.stats.rerolls || 0) + 1;
            if (action === 'generate_plan') profileData.stats.plan_generations = (profileData.stats.plan_generations || 0) + 1;
            if (action === 'log_workout') profileData.stats.completions = (profileData.stats.completions || 0) + 1;

            // 4. Persist
            await client.query(
                `UPDATE user_profiles
         SET profile_data = $1::jsonb,
             updated_at = now()
         WHERE user_id = $2`,
                [JSON.stringify(profileData), user.userId]
            );

            // Log Event
            await client.query(
                `INSERT INTO gamification_log(id, user_id, action, reward_willpower, reward_badges, created_at)
          VALUES(gen_random_uuid(), $1, $2, $3, $4, now())`,
                [user.userId, action, willpowerGain, newBadges.length > 0 ? JSON.stringify(newBadges) : null]
            );

            await client.query('COMMIT');

            return {
                success: true,
                profile: profileData,
                willpowerGained: willpowerGain,
                newBadges: newBadges,
                message
            };

        } catch (e: unknown) {
            await client.query('ROLLBACK');
            req.log.error(e);
            return reply.status(500).send({ error: 'Gamification action failed' });
        } finally {
            client.release();
        }
    });

    // Get current gamification state
    app.get('/gamification/state', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;

        try {
            const { rows } = await pool.query(
                `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
                [user.userId]
            );

            const profileData = rows[0]?.profile_data || {};

            return reply.send({
                xp: profileData.willpower || 0,
                sparks: profileData.sparks || 0,
                flexPoints: profileData.flexPoints || 0,
                badges: profileData.badges || [],
                level: Math.floor((profileData.willpower || 0) / 100) + 1,
                streak: profileData.streak || 0
            });
        } catch (e: unknown) {
            req.log.error(e);
            return reply.status(500).send({ error: 'Failed to fetch gamification state' });
        }
    });

    // Reconcile client state with server (server is authoritative)
    app.post('/gamification/reconcile', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;

        try {
            const { rows } = await pool.query(
                `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
                [user.userId]
            );

            const profileData = rows[0]?.profile_data || {};

            // Server state is always authoritative
            return reply.send({
                xp: profileData.willpower || 0,
                sparks: profileData.sparks || 0,
                flexPoints: profileData.flexPoints || 0,
                badges: profileData.badges || [],
                level: Math.floor((profileData.willpower || 0) / 100) + 1,
                streak: profileData.streak || 0
            });
        } catch (e: unknown) {
            req.log.error(e);
            return reply.status(500).send({ error: 'Reconciliation failed' });
        }
    });

    // Validate transaction before allowing it
    app.post('/gamification/validate-transaction', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            type: z.enum(['spend_sparks', 'spend_flex', 'earn_sparks', 'earn_flex']),
            amount: z.number().positive(),
            reason: z.string(),
            timestamp: z.number()
        }).parse(req.body);

        try {
            const { rows } = await pool.query(
                `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
                [user.userId]
            );

            const profileData = rows[0]?.profile_data || {};
            const currentSparks = profileData.sparks || 0;
            const currentFlex = profileData.flexPoints || 0;

            if (body.type === 'spend_sparks' && currentSparks < body.amount) {
                return reply.send({ allowed: false, error: 'Insufficient sparks' });
            }
            if (body.type === 'spend_flex' && currentFlex < body.amount) {
                return reply.send({ allowed: false, error: 'Insufficient flex points' });
            }

            const newBalance = body.type === 'spend_sparks' ? currentSparks - body.amount
                : body.type === 'earn_sparks' ? currentSparks + body.amount
                : body.type === 'spend_flex' ? currentFlex - body.amount
                : currentFlex + body.amount;

            return reply.send({ allowed: true, newBalance });
        } catch (e: unknown) {
            req.log.error(e);
            return reply.status(500).send({ error: 'Validation failed' });
        }
    });

    // Execute transaction with server-side validation
    app.post('/gamification/transaction', { preHandler: authGuard }, async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            type: z.enum(['spend_sparks', 'spend_flex', 'earn_sparks', 'earn_flex']),
            amount: z.number().positive(),
            reason: z.string(),
            timestamp: z.number()
        }).parse(req.body);

        const client = await pool.connect();
        try {
            await client.query('SET statement_timeout = 10000');
            await client.query('BEGIN');

            const { rows } = await client.query(
                `SELECT profile_data FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
                [user.userId]
            );

            const profileData = rows[0]?.profile_data || {};

            if (body.type === 'spend_sparks') {
                if ((profileData.sparks || 0) < body.amount) {
                    await client.query('ROLLBACK');
                    return reply.status(400).send({ error: 'Insufficient sparks' });
                }
                profileData.sparks = (profileData.sparks || 0) - body.amount;
            } else if (body.type === 'earn_sparks') {
                profileData.sparks = (profileData.sparks || 0) + body.amount;
            } else if (body.type === 'spend_flex') {
                if ((profileData.flexPoints || 0) < body.amount) {
                    await client.query('ROLLBACK');
                    return reply.status(400).send({ error: 'Insufficient flex points' });
                }
                profileData.flexPoints = (profileData.flexPoints || 0) - body.amount;
            } else if (body.type === 'earn_flex') {
                profileData.flexPoints = (profileData.flexPoints || 0) + body.amount;
            }

            await client.query(
                `UPDATE user_profiles SET profile_data = $1::jsonb, updated_at = now() WHERE user_id = $2`,
                [JSON.stringify(profileData), user.userId]
            );

            await client.query('COMMIT');

            return reply.send({
                xp: profileData.willpower || 0,
                sparks: profileData.sparks || 0,
                flexPoints: profileData.flexPoints || 0,
                badges: profileData.badges || [],
                level: Math.floor((profileData.willpower || 0) / 100) + 1,
                streak: profileData.streak || 0
            });
        } catch (e: unknown) {
            await client.query('ROLLBACK');
            req.log.error(e);
            return reply.status(500).send({ error: 'Transaction failed' });
        } finally {
            client.release();
        }
    });
}
