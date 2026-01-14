import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AiService } from '../../../application/services/aiService.js';
import { PlanService } from '../../../application/services/planService.js';
import { withErrorHandler } from './_utils/errorHandler.js';
import { env } from '../../../config/env.js';
import {
    UserProfileSchema,
    PlanSettingsSchema,
    TrainingPlanSchema,
    MealPlanSchema
} from '../schemas/plans.js';

export async function planActionsRoutes(app: FastifyInstance) {
    const aiService = new AiService();

    // Generate a complete Smart Plan (Training + Nutrition)
    app.post('/plans/generate', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            profile: UserProfileSchema,
            settings: PlanSettingsSchema,
            lang: z.string().default('en'),
            startDate: z.string().optional(),
            calculatedBiometrics: z.any().optional()
        }).parse(req.body);

        // Explicit API key check
        if (!env.geminiApiKey) {
            req.log.error({ error: 'GEMINI_API_KEY not configured', requestId: (req as any).requestId });
            return reply.status(500).send({ error: 'GEMINI_API_KEY not configured on backend. Please contact support.' });
        }

        const { profile, settings, lang, calculatedBiometrics } = body;
        const durationDays = settings.duration || 7;

        // --- Prompt Construction (Restored from plans.ts) ---
        const focusAreas = profile.focusAreas || [];
        const equipment = profile.equipment || [];
        const trainingFrequency = settings.frequency || profile.workoutDaysPerWeek || 4;
        const detailedTrainingGoals = profile.specificGoals?.join(', ') || settings.cycleGoal;

        const memoryPrompt = profile.bioMemory ? `BIO-MEMORY: ${profile.bioMemory.observations.join('; ')}` : "";
        const contraindications = PlanService.getContraindications(profile.conditions || []);
        const safetyPrompt = contraindications.length > 0 ? `CONTRAINDICATIONS: ${contraindications.join(', ')}` : "Ensure safety.";

        const tdee = calculatedBiometrics?.tdee || 2000;
        const target = calculatedBiometrics?.target || 2000;
        const safetyFloor = calculatedBiometrics?.safetyFloor || 1200;

        let calorieLogic = `TARGET: ${target} kcal/day. FLOOR: ${safetyFloor} kcal.`;
        if (settings.intensity === 'sprint') {
            calorieLogic = `SPRINT MODE: Aggressive deficit. Target ${Math.max(safetyFloor, Math.round(tdee * 0.75))} kcal. High Protein.`;
        }

        // Debt Logic
        if (settings.debtStrategy === 'active') {
            calorieLogic += ` DEBT NOTE: User is in debt but paying via activity. DO NOT reduce food calories below target.`;
        } else if (settings.debtStrategy === 'deficit') {
            calorieLogic += ` DEBT NOTE: Prioritize filling, low-calorie density foods. Repay debt via caloric deficit.`;
        }

        const mealStructurePrompt = settings.mealFrequency === 'omad' ? "CONSOLIDATE ALL CALORIES INTO ONE MASSIVE DINNER." : "";

        const trainingPrompt = `
      PHASE A (TRAINING - ${durationDays} DAY CYCLE).
      Freq: ${trainingFrequency} Days/Wk.
      Goals: ${detailedTrainingGoals}. Level: ${profile.fitnessLevel}.
      Equipment: ${equipment.join(', ')}. Focus: [${focusAreas.join(', ')}].
      ${memoryPrompt}
      ${safetyPrompt}
      ${settings.debtStrategy === 'active' ? 'CRITICAL: Add a "Debt Burner" cardio finisher (15 mins) to EVERY workout.' : ''}
      Return JSON: { "name": "...", "analysis": "...", "schedule": [{"day": "Day 1", "focus": "...", "exercises": [{"name": "...", "sets": "3", "reps": "10", "notes": ""}]}] }
      Language: ${lang}
    `;

        const nutritionPrompt = `
      PHASE B (NUTRITION - FULL ${durationDays} DAY PLAN).
      Diet: ${settings.dietType || profile.dietaryPreference || 'none'}.
      ${mealStructurePrompt}
      ${calorieLogic}
      ${(settings.dietType === 'shreddmax' || profile.dietaryPreference === 'shreddmax') ? `SHREDDMAX PROTOCOL:
        1. BREAKFAST: FRUIT ONLY until Noon. NO fats, NO proteins.
        2. POST-NOON: Low Fat, High Protein, Moderate Carb.
        3. NO SEED OILS. Only Saturated fats (Butter, Coconut Oil, Tallow).` : ''}
      Return JSON: { "name": "...", "overview": "...", "days": [{"day": "Day 1", "meals": [{"type": "breakfast", "recipe": {"name": "...", "calories": 500, "ingredients": [], "instructions": [{"simple": "...", "detailed": "..."}]}}]}] }
      Language: ${lang}
    `;

        // --- Generation ---
        let trainText, nutText;
        try {
            [trainText, nutText] = await Promise.all([
                aiService.generateText({ prompt: trainingPrompt, generationConfig: { responseMimeType: 'application/json' } }),
                aiService.generateText({ prompt: nutritionPrompt, generationConfig: { responseMimeType: 'application/json' } })
            ]);
        } catch (e: any) {
            req.log.error({ error: 'AI generation failed', message: e.message, requestId: (req as any).requestId });
            throw new Error(`AI generation failed: ${e.message}. Please check GEMINI_API_KEY configuration.`);
        }

        // Validate AI responses
        if (!trainText?.text) {
            req.log.error({ error: 'Training plan response empty', requestId: (req as any).requestId });
            throw new Error('Training plan generation returned empty response. Please try again.');
        }
        if (!nutText?.text) {
            req.log.error({ error: 'Nutrition plan response empty', requestId: (req as any).requestId });
            throw new Error('Nutrition plan generation returned empty response. Please try again.');
        }

        // Parse JSON with error handling
        let trainingPlan, nutritionPlan;
        try {
            const cleanedTrainText = PlanService.cleanGeminiJson(trainText.text);
            trainingPlan = JSON.parse(cleanedTrainText || '{}');
        } catch (e: any) {
            req.log.error({ error: 'Training plan JSON parse failed', rawText: trainText.text?.substring(0, 200), requestId: (req as any).requestId });
            throw new Error('Failed to parse training plan response. Please try again.');
        }

        try {
            const cleanedNutText = PlanService.cleanGeminiJson(nutText.text);
            nutritionPlan = JSON.parse(cleanedNutText || '{}');
        } catch (e: any) {
            req.log.error({ error: 'Nutrition plan JSON parse failed', rawText: nutText.text?.substring(0, 200), requestId: (req as any).requestId });
            throw new Error('Failed to parse nutrition plan response. Please try again.');
        }

        // --- Validation & Normalization ---
        if (!Array.isArray(trainingPlan?.schedule) || trainingPlan.schedule.length === 0) {
            throw new Error('Training plan generation failed or returned empty');
        }
        if (!Array.isArray(nutritionPlan?.days) || nutritionPlan.days.length === 0) {
            throw new Error('Nutrition plan generation failed or returned empty');
        }

        // Process each meal for recipes and normalization
        if (nutritionPlan.days) {
            for (const day of nutritionPlan.days) {
                if (Array.isArray(day.meals)) {
                    for (const meal of day.meals) {
                        // Ensure meal.recipe exists before proceeding
                        if (meal && meal.recipe) {
                            const mealName = meal.recipe.name;
                            if (mealName) {
                                try {
                                    const existing = await PlanService.getExistingRecipe(mealName);
                                    if (existing) {
                                        Object.assign(meal.recipe, existing);
                                    }
                                } catch (e: any) {
                                    req.log.warn({ error: 'Failed to check existing recipe', mealName, requestId: (req as any).requestId });
                                }
                            }

                            // Normalize instructions safely
                            meal.recipe.instructions = PlanService.normalizeInstructions(meal.recipe.instructions || []);
                        }
                    }
                }
            }
        }

        // --- Persistence ---
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            try {
                const { trainingId, mealPlanId } = await PlanService.savePlanToDb(client, user.userId, trainingPlan, nutritionPlan, body.startDate);

                // Save to archive (auto)
                const archiveId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
                await client.query(
                    `INSERT INTO saved_smart_plans(id, user_id, name, date_created, training, nutrition, progress_day_index, summary)
             VALUES($1, $2, $3, now(), $4, $5, 0, $6)`,
                    [archiveId, user.userId, `${trainingPlan.name || 'Smart Plan'} (Auto-Saved)`, trainingPlan, nutritionPlan, 'Generated Smart Plan']
                );

                await client.query('COMMIT');
                return reply.send({ training: trainingPlan, nutrition: nutritionPlan, trainingId, mealPlanId, archiveId });
            } catch (dbError: any) {
                await client.query('ROLLBACK');
                req.log.error({
                    error: 'Database save failed',
                    message: dbError.message,
                    code: dbError.code,
                    requestId: (req as any).requestId
                });

                // Provide user-friendly error messages
                if (dbError.code === '23505') {
                    throw new Error('Plan already exists. Please try again.');
                } else if (dbError.code === '23503') {
                    throw new Error('Invalid data reference. Please contact support.');
                } else if (dbError.code === '23502') {
                    throw new Error('Required data is missing. Please try again.');
                } else {
                    throw new Error(`Failed to save plan: ${dbError.message || 'Database error'}`);
                }
            }
        } catch (e: any) {
            // Re-throw if it's already a user-friendly error
            throw e;
        } finally {
            client.release();
        }
    }));

    // Save an existing generated plan
    app.post('/plans/save-generated', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            training: TrainingPlanSchema,
            nutrition: MealPlanSchema,
            startDate: z.string().optional()
        }).parse(req.body);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await PlanService.savePlanToDb(client, user.userId, body.training, body.nutrition, body.startDate);
            await client.query('COMMIT');
            return reply.send({ success: true, ...result });
        } catch (e: any) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }));

    // Reroll meal
    app.post('/plans/reroll/meal', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            type: z.string(),
            targetCalories: z.number(),
            profile: z.any(),
            excludes: z.array(z.string()).default([]),
            additionalIngredients: z.string().optional(),
            lang: z.string().default('en'),
            avoidItem: z.string().optional()
        }).parse(req.body);

        const prompt = `Suggest ONE alternative ${body.type} recipe (~${body.targetCalories} kcal).
      Diet: ${body.profile?.dietaryPreference || 'none'}. Excludes: ${body.excludes.join(', ') || 'none'}.
      Language: ${body.lang}.
      Return JSON: { "type": "...", "recipe": { "name": "...", "calories": 500, "ingredients": [], "instructions": [{"simple": "...", "detailed": "..."}] } }`;

        const { text } = await aiService.generateText({ prompt, generationConfig: { responseMimeType: 'application/json' } });
        const meal = JSON.parse(PlanService.cleanGeminiJson(text) || '{}');

        if (meal?.recipe) {
            meal.recipe.instructions = PlanService.normalizeInstructions(meal.recipe.instructions);
        }

        return reply.send({ meal });
    }));

    // Reroll exercise
    app.post('/plans/reroll/exercise', { preHandler: authGuard }, withErrorHandler(async (req, reply) => {
        const user = (req as any).user;
        const body = z.object({
            currentName: z.string(),
            focus: z.string(),
            profile: z.any(),
            lang: z.string().default('en'),
            constraint: z.string().optional()
        }).parse(req.body);

        const prompt = `Suggest ONE alternative exercise to replace "${body.currentName}" for a "${body.focus}" workout.
      Level: ${body.profile?.fitnessLevel}. Equipment: ${(body.profile?.equipment || []).join(', ')}.
      Language: ${body.lang}.
      Return JSON: { "name": "...", "sets": "...", "reps": "...", "notes": "..." }`;

        const { text } = await aiService.generateText({ prompt, generationConfig: { responseMimeType: 'application/json' } });
        const exercise = JSON.parse(PlanService.cleanGeminiJson(text) || '{}');

        return reply.send({ exercise });
    }));
}
