import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { proGuard } from '../hooks/proGuard.js';
import { pool } from '../../db/pool.js';
import { AiService } from '../../../application/services/aiService.js';
import { PlanService } from '../../../application/services/planService.js';
import { jobProcessor } from '../../../application/services/jobProcessor.js';
import { withErrorHandler } from './_utils/errorHandler.js';
import { env } from '../../../config/env.js';
import {
    UserProfileSchema,
    PlanSettingsSchema,
    TrainingPlanSchema,
    MealPlanSchema,
    CalculatedBiometricsSchema
} from '../schemas/plans.js';
import { AuthenticatedRequest } from '../types.js';

export async function planActionsRoutes(app: FastifyInstance) {
    const aiService = new AiService();

    // Generate a complete Smart Plan (Training + Nutrition)
    app.post('/plans/generate', { preHandler: proGuard }, withErrorHandler(async (req: any, reply) => {
        const user = req.user;
        const body = z.object({
            profile: UserProfileSchema,
            settings: PlanSettingsSchema,
            lang: z.string().default('en'),
            startDate: z.string().optional(),
            calculatedBiometrics: CalculatedBiometricsSchema.optional()
        }).parse(req.body);

        // Explicit API key check
        if (!env.geminiApiKey) {
            req.log.error({ error: 'GEMINI_API_KEY not configured', requestId: req.requestId });
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
      You are a master Bio-Planner specialized in longevity, performance, and clinical nutrition.
      Your goal is to design a high-performance training protocol.

      PROTOCOL PARAMETERS:
      - PHASE: TRAINING (A)
      - CYCLE DURATION: ${durationDays} DAYS (EXACTLY)
      - FREQUENCY: ${trainingFrequency} DAYS/WEEK
      - LEVEL: ${profile.fitnessLevel}
      - PRIMARY GOALS: ${detailedTrainingGoals}
      - EQUIPMENT: ${equipment.join(', ') || 'Bodyweight only'}
      - FOCUS AREAS: [${focusAreas.join(', ')}]
      
      CONTRAINDICATIONS:
      ${safetyPrompt}
      ${memoryPrompt}

      STRATEGIC NOTES:
      ${settings.debtStrategy === 'active' ? 'CRITICAL: Add a "Debt Burner" cardio finisher (15 mins) to EVERY workout to compensate for caloric debt.' : ''}

      OUTPUT RULES:
      1. You MUST generate EXACTLY ${durationDays} days in the "schedule" array.
      2. If a day is a Rest Day, specify it clearly in the "focus". 
      3. All content (names, exercises, notes) MUST be in the requested Language: ${lang}.
      4. JSON Keys MUST stay in English as defined below.
      5. NO placeholders or partial plans. No "..." allowed.

      JSON STRUCTURE:
      { 
        "name": "Creative Program Name", 
        "analysis": "Brief scientific rationale", 
        "schedule": [
          {
            "day": "Day 1", 
            "focus": "Hypertrophy - Push", 
            "exercises": [
              {
                "name": "Bench Press", 
                "sets": "3", 
                "reps": "10", 
                "notes": "Control tempo 3-1-1",
                "instructions": [
                  {"simple": "Step 1 summary", "detailed": "Detailed description of Step 1 with form cues."},
                  {"simple": "Step 2 summary", "detailed": "Detailed description of Step 2..."}
                ]
              }
            ]
          },
          ... repeat for exactly ${durationDays} days ...
        ] 
      }

      INSTRUCTION QUALITY RULES:
      1. Every exercise MUST have between 5 and 8 instructional steps in the "instructions" array.
      2. Use simple/detailed split for every step.
    `;

        const nutritionPrompt = `
      You are a clinical nutritionist and performance cook.
      Your goal is to design a bio-synchronized meal plan.

      PROTOCOL PARAMETERS:
      - PHASE: NUTRITION (B)
      - CYCLE DURATION: ${durationDays} DAYS (EXACTLY)
      - DIET TYPE: ${settings.dietType || profile.dietaryPreference || 'Standard Balanced'}
      - MEAL FREQUENCY: ${settings.mealFrequency || '3 meals'}
      - CALORIE TARGET: ${calorieLogic}
      - EXCLUDED INGREDIENTS: ${(profile.excludedIngredients || []).join(', ') || 'None'}
      
      ${(settings.dietType === 'shreddmax' || profile.dietaryPreference === 'shreddmax') ? `SHREDDMAX PROTOCOL (STRICT):
        1. BREAKFAST: FRUIT ONLY until Noon. NO fats, NO proteins.
        2. POST-NOON: Low Fat, High Protein, Moderate Carb.
        3. NO SEED OILS. Only Saturated fats (Butter, Coconut Oil, Tallow).` : ''}

      ${mealStructurePrompt}

      OUTPUT RULES:
      1. You MUST generate EXACTLY ${durationDays} days in the "days" array.
      2. Every day MUST have at least 3 distinct meals (breakfast, lunch, dinner) unless OMAD is specified.
      3. Total daily calories MUST strictly align with the target: ${target} kcal.
      4. All content (names, overview, recipe names, instructions) MUST be in the requested Language: ${lang}.
      5. JSON Keys MUST stay in English as defined below.
      6. NO placeholders, "..." or "Example/Örnek" labels. Use real ingredients and real cooking steps.

      JSON STRUCTURE:
      { 
        "name": "Creative Plan Name", 
        "overview": "Short nutrition summary", 
        "days": [
          {
            "day": "Day 1", 
            "targetCalories": ${target},
            "meals": [
              {
                "type": "breakfast", 
                "recipe": {
                  "name": "Real Recipe Name", 
                  "calories": 450, 
                  "time": "15 min",
                  "ingredients": ["Item A", "Item B"], 
                  "instructions": [
                    {"simple": "Prep base", "detailed": "Wash and chop ingredients..."},
                    {"simple": "Step 2", "detailed": "Detailed cooking step..."},
                    {"simple": "Step 3", "detailed": "Next step..."},
                    {"simple": "Step 4", "detailed": "Next step..."},
                    {"simple": "Step 5", "detailed": "Final plating..."}
                  ]
                }
              },
              ... more meals ...
            ]
          },
          ... repeat for exactly ${durationDays} days ...
        ] 
      }

      INSTRUCTION QUALITY RULES:
      1. Every recipe MUST have between 5 and 8 instructional steps in the "instructions" array.
      2. NEVER use single-step instructions. Break the process down into logical phases.
    `;

        // --- Generation ---
        let trainText, nutText;
        try {
            req.log.info({
                action: 'Starting AI generation',
                durationDays,
                trainingFrequency,
                requestId: req.requestId
            });

            [trainText, nutText] = await Promise.all([
                aiService.generateText({ prompt: trainingPrompt, generationConfig: { responseMimeType: 'application/json' } }),
                aiService.generateText({ prompt: nutritionPrompt, generationConfig: { responseMimeType: 'application/json' } })
            ]);

            req.log.info({
                action: 'AI generation completed',
                trainingTextLength: trainText?.text?.length || 0,
                nutritionTextLength: nutText?.text?.length || 0,
                requestId: req.requestId
            });
        } catch (e: unknown) {
            const error = e as Error;
            req.log.error({
                error: 'AI generation failed',
                message: error.message,
                stack: error.stack,
                name: error.name,
                requestId: req.requestId
            });
            throw new Error(`AI generation failed: ${error.message}. Please check GEMINI_API_KEY configuration.`);
        }

        // Validate AI responses
        if (!trainText?.text) {
            req.log.error({ error: 'Training plan response empty', requestId: req.id });
            throw new Error('Training plan generation returned empty response. Please try again.');
        }
        if (!nutText?.text) {
            req.log.error({ error: 'Nutrition plan response empty', requestId: req.id });
            throw new Error('Nutrition plan generation returned empty response. Please try again.');
        }

        // Parse JSON with error handling
        let trainingPlan, nutritionPlan;
        try {
            const cleanedTrainText = PlanService.cleanGeminiJson(trainText.text);
            trainingPlan = JSON.parse(cleanedTrainText || '{}');
        } catch (e: unknown) {
            const error = e as Error;
            const rawPreview = trainText.text?.substring(0, 500) || 'No text received';
            req.log.error({
                error: 'Training plan JSON parse failed',
                parseError: error.message,
                rawTextPreview: rawPreview,
                rawTextLength: trainText.text?.length || 0,
                requestId: req.requestId
            });
            throw new Error(`Failed to parse training plan: ${error.message}. Raw response preview: ${rawPreview.substring(0, 200)}`);
        }

        try {
            const cleanedNutText = PlanService.cleanGeminiJson(nutText.text);
            nutritionPlan = JSON.parse(cleanedNutText || '{}');
        } catch (e: unknown) {
            const error = e as Error;
            const rawPreview = nutText.text?.substring(0, 500) || 'No text received';
            req.log.error({
                error: 'Nutrition plan JSON parse failed',
                parseError: error.message,
                rawTextPreview: rawPreview,
                rawTextLength: nutText.text?.length || 0,
                requestId: req.requestId
            });
            throw new Error(`Failed to parse nutrition plan: ${error.message}. Raw response preview: ${rawPreview.substring(0, 200)}`);
        }

        // --- Validation & Normalization ---
        if (!Array.isArray(trainingPlan?.schedule) || trainingPlan.schedule.length === 0) {
            req.log.error({
                error: 'Training plan validation failed',
                trainingPlanKeys: trainingPlan ? Object.keys(trainingPlan) : 'null',
                scheduleType: Array.isArray(trainingPlan?.schedule) ? 'array' : typeof trainingPlan?.schedule,
                scheduleLength: trainingPlan?.schedule?.length || 0,
                requestId: req.requestId
            });
            throw new Error(`Training plan validation failed: schedule is empty or invalid.`);
        }

        // Enforce minimum days for training if requested duration is significant
        if (trainingPlan.schedule.length < Math.min(durationDays, 3)) {
            req.log.error({
                error: 'Training plan duration mismatch',
                requested: durationDays,
                received: trainingPlan.schedule.length,
                requestId: req.requestId
            });
            throw new Error(`AI generated an incomplete training plan (${trainingPlan.schedule.length}/${durationDays} days).`);
        }

        if (!Array.isArray(nutritionPlan?.days) || nutritionPlan.days.length === 0) {
            req.log.error({
                error: 'Nutrition plan validation failed',
                nutritionPlanKeys: nutritionPlan ? Object.keys(nutritionPlan) : 'null',
                daysType: Array.isArray(nutritionPlan?.days) ? 'array' : typeof nutritionPlan?.days,
                daysLength: nutritionPlan?.days?.length || 0,
                requestId: req.requestId
            });
            throw new Error(`Nutrition plan validation failed: days array is empty or missing.`);
        }

        // STRICT CHECK: Ensure correct number of days for nutrition
        if (nutritionPlan.days.length < durationDays) {
            req.log.error({
                error: 'Nutrition plan duration mismatch',
                requested: durationDays,
                received: nutritionPlan.days.length,
                requestId: req.requestId
            });
            throw new Error(`AI generated an incomplete nutrition plan (${nutritionPlan.days.length}/${durationDays} days).`);
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
                                } catch (e: unknown) {
                                    const error = e as Error;
                                    req.log.warn({ error: 'Failed to check existing recipe', mealName, requestId: req.id });
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

                // --- BACKGROUND ASSET GENERATION TRIGGER ---
                // We queue these jobs after COMMIT so they don't block the response and 
                // we're sure the plan is saved.
                try {
                    // 1. Queue Exercise Jobs (Atlas & Nova for each movement)
                    if (trainingPlan.schedule) {
                        for (const day of trainingPlan.schedule) {
                            if (day.exercises) {
                                for (const ex of day.exercises) {
                                    if (ex.name) {
                                        await jobProcessor.submitJob(user.userId, 'EXERCISE_GENERATION', {
                                            name: ex.name,
                                            instructions: ex.instructions,
                                            userProfile: profile
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // 2. Queue Meal Jobs
                    if (nutritionPlan.days) {
                        for (const day of nutritionPlan.days) {
                            if (day.meals) {
                                for (const meal of day.meals) {
                                    if (meal.recipe && meal.recipe.name) {
                                        await jobProcessor.submitJob(user.userId, 'MEAL_GENERATION', {
                                            name: meal.recipe.name,
                                            instructions: meal.recipe.instructions,
                                            ingredients: meal.recipe.ingredients
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch (jobErr) {
                    req.log.warn({ error: 'Failed to queue background jobs', jobErr, requestId: req.requestId });
                }

                return reply.send({ training: trainingPlan, nutrition: nutritionPlan, trainingId, mealPlanId, archiveId });
            } catch (dbError: any) {
                await client.query('ROLLBACK');
                req.log.error({
                    error: 'Database save failed',
                    message: dbError.message,
                    code: dbError.code,
                    requestId: req.requestId
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
        } catch (e: unknown) {
            // Re-throw if it's already a user-friendly error
            throw e;
        } finally {
            client.release();
        }
    }));

    // Save an existing generated plan
    app.post('/plans/save-generated', { preHandler: authGuard }, withErrorHandler(async (req: any, reply) => {
        const user = req.user;
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
        } catch (e: unknown) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }));

    // Reroll meal
    app.post('/plans/reroll/meal', { preHandler: authGuard }, withErrorHandler(async (req: any, reply) => {
        const user = req.user;
        const body = z.object({
            type: z.string(),
            targetCalories: z.number(),
            profile: UserProfileSchema,
            excludes: z.array(z.string()).default([]),
            additionalIngredients: z.string().optional(),
            lang: z.string().default('en'),
            avoidItem: z.string().optional()
        }).parse(req.body);

        let attempts = 0;
        const MAX_RETRIES = 3;
        let lastError = "";

        while (attempts < MAX_RETRIES) {
            attempts++;
            try {
                const ingredientInstruction = body.additionalIngredients
                    ? `\nMUST INCLUDE INGREDIENT: "${body.additionalIngredients}" (Critical Requirement).`
                    : "";

                const prompt = `Suggest ONE alternative ${body.type} recipe (~${body.targetCalories} kcal).
              Diet: ${body.profile?.dietaryPreference || 'none'}. Excludes: ${body.excludes.join(', ') || 'none'}.
              Language: ${body.lang}.${ingredientInstruction}
              
              CRITICAL QUALITY RULES:
              1. MUST have 5-8 distinct cooking steps.
              2. "detailed" instruction must be 2-3 sentences.
              3. Include "nutritionTips" (science-based health tips).
              
              Return JSON: { 
                "type": "${body.type}", 
                "recipe": { 
                    "name": "Creative Name", 
                    "calories": ${body.targetCalories}, 
                    "ingredients": ["Item 1", "Item 2"], 
                    "instructions": [{"simple": "Action", "detailed": "Detailed step..."}],
                    "nutritionTips": ["Tip 1", "Tip 2"]
                } 
              }`;

                const { text } = await aiService.generateText({ prompt, generationConfig: { responseMimeType: 'application/json' } });
                const meal = JSON.parse(PlanService.cleanGeminiJson(text) || '{}');

                if (meal?.recipe) { // Normalize
                    meal.recipe.instructions = PlanService.normalizeInstructions(meal.recipe.instructions);
                }

                // VALIDATION
                if (!meal?.recipe?.instructions || !Array.isArray(meal.recipe.instructions)) throw new Error("Missing instructions");
                if (meal.recipe.instructions.length < 5) throw new Error(`Only ${meal.recipe.instructions.length} steps (min 5 required)`);

                // Map nutritionTips -> prepTips for UI compatibility if needed
                if (meal.recipe.nutritionTips && !meal.recipe.prepTips) {
                    meal.recipe.prepTips = meal.recipe.nutritionTips;
                }

                return reply.send({ meal });

            } catch (e: unknown) {
                const error = e as Error;
                lastError = error.message;
                req.log.warn({ msg: `Reroll attempt ${attempts} failed`, error: error.message });
                if (attempts === MAX_RETRIES) {
                    req.log.error({ msg: "Reroll failed after retries", error: lastError });
                    throw new Error(`Failed to generate valid meal after ${MAX_RETRIES} attempts: ${lastError}`);
                }
            }
        }
    }));

    // Reroll exercise
    app.post('/plans/reroll/exercise', { preHandler: authGuard }, withErrorHandler(async (req: any, reply) => {
        const user = req.user;
        const body = z.object({
            currentName: z.string(),
            focus: z.string(),
            profile: UserProfileSchema,
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
