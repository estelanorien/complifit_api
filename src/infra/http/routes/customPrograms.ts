import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { withErrorHandler } from './_utils/errorHandler.js';
import { CustomProgramService } from '../../../application/services/customProgramService.js';
import { AuthenticatedRequest } from '../types.js';

export async function customProgramRoutes(app: FastifyInstance) {
    // Parse image to text (OCR)
    app.post('/custom-programs/parse-photo', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            imageBase64: z.string(),
            mimeType: z.string()
        }).parse(req.body);

        // Check usage limits
        const { rows } = await pool.query(
            `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
            [user.userId]
        );

        const profile = rows[0]?.profile_data || {};
        const subscriptionTier = profile.subscriptionTier || 'free';
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

        // Track monthly usage
        const usageKey = `customProgram_${currentMonth}`;
        const currentUsage = (profile.usageStats && profile.usageStats[usageKey]) || 0;
        const maxFreeParses = 1;
        const maxProParses = 4;
        const maxParses = subscriptionTier === 'pro' ? maxProParses : maxFreeParses;

        if (currentUsage >= maxParses) {
            return reply.status(403).send({
                error: 'Monthly parse limit reached',
                limit: maxParses,
                tier: subscriptionTier,
                message: subscriptionTier === 'free'
                    ? 'Upgrade to Pro for more parses, or this will cost Willpower'
                    : 'Monthly limit reached. Resets next month.'
            });
        }

        // Extract text
        const extractedText = await CustomProgramService.extractTextFromImage(
            body.imageBase64,
            body.mimeType
        );

        // Increment usage
        await pool.query(
            `UPDATE user_profiles 
             SET profile_data = jsonb_set(
                 COALESCE(profile_data, '{}'::jsonb),
                 '{usageStats, ${usageKey}}',
                 to_jsonb($1::int),
                 true
             )
             WHERE user_id = $2`,
            [currentUsage + 1, user.userId]
        );

        return reply.send({
            text: extractedText,
            usage: {
                current: currentUsage + 1,
                max: maxParses,
                tier: subscriptionTier
            }
        });
    }));

    // Convert approved text to structured program
    app.post('/custom-programs/extract-structure', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            text: z.string(),
            type: z.enum(['training', 'nutrition', 'both'])
        }).parse(req.body);

        const { rows } = await pool.query(
            `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
            [user.userId]
        );
        const userProfile = rows[0]?.profile_data || {};

        let result: any = {};

        if (body.type === 'training' || body.type === 'both') {
            result.training = await CustomProgramService.parseTrainingProgram(body.text, userProfile);
        }

        if (body.type === 'nutrition' || body.type === 'both') {
            result.nutrition = await CustomProgramService.parseNutritionPlan(body.text, userProfile);
        }

        return reply.send(result);
    }));

    // Validate program (Free tier)
    app.post('/custom-programs/validate', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            program: z.any(),
            type: z.enum(['training', 'nutrition'])
        }).parse(req.body);

        const { rows } = await pool.query(
            `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
            [user.userId]
        );
        const userProfile = rows[0]?.profile_data || {};

        const validation = await CustomProgramService.validateProgram(
            body.program,
            body.type,
            userProfile
        );

        return reply.send(validation);
    }));

    // Comprehensive coaching (Pro tier)
    app.post('/custom-programs/coach-feedback', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as AuthenticatedRequest).user;
        const body = z.object({
            program: z.any(),
            type: z.enum(['training', 'nutrition'])
        }).parse(req.body);

        const { rows } = await pool.query(
            `SELECT profile_data FROM user_profiles WHERE user_id = $1`,
            [user.userId]
        );
        const userProfile = rows[0]?.profile_data || {};
        const subscriptionTier = userProfile.subscriptionTier || 'free';

        if (subscriptionTier !== 'pro') {
            return reply.status(403).send({
                error: 'Pro subscription required',
                message: 'Comprehensive coaching is a Pro feature. Upgrade to unlock!'
            });
        }

        const feedback = await CustomProgramService.provideCoachingFeedback(
            body.program,
            body.type,
            userProfile
        );

        return reply.send(feedback);
    }));
}
