import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { proGuard } from '../hooks/proGuard.js';
import { pool } from '../../db/pool.js';
import { smartPlanner, SmartPlanRequest } from '../../../application/services/SmartPlannerService.js';
import { PlanService } from '../../../application/services/planService.js';
import { jobProcessor } from '../../../application/services/jobProcessor.js';
import { withErrorHandler } from './_utils/errorHandler.js';
import { UserProfileSchema } from '../schemas/plans.js';

export async function smartPlanRoutes(app: FastifyInstance) {

  const generateSchema = z.object({
    profile: UserProfileSchema,
    days: z.number().min(1).max(30).default(7),
    lang: z.string().default('en'),
    overrideStyle: z.string().optional(),
    startDate: z.string().optional(),
  });

  /**
   * POST /plans/smart — Generate a coordinated training + nutrition plan.
   * Uses SmartPlannerService (Claude Opus coordinated call with Gemini fallback).
   */
  app.post('/plans/smart', { preHandler: proGuard }, withErrorHandler(async (req: any, reply) => {
    const user = req.user;
    const body = generateSchema.parse(req.body);

    const profile = body.profile;

    const request: SmartPlanRequest = {
      profile: {
        age: profile.age || 30,
        gender: profile.gender || 'male',
        weight: profile.weight || 70,
        height: profile.height || 170,
        fitnessLevel: profile.fitnessLevel || 'intermediate',
        goal: profile.primaryGoal || 'general_fitness',
        specificGoals: profile.specificGoals,
        dietaryPreference: profile.dietaryPreference,
        exclusions: profile.excludedIngredients,
        medicalConditions: profile.conditions,
        equipment: profile.equipment,
        focusAreas: profile.focusAreas,
        trainingStyle: profile.trainingStyle,
        activityLevel: 'moderate',
        sports: profile.sports,
        glp1: profile.glp1Mode,
      },
      days: body.days,
      lang: body.lang,
      overrideStyle: body.overrideStyle,
    };

    const result = await smartPlanner.generate(request);

    // Validate results
    if (!Array.isArray(result.training?.schedule) || result.training.schedule.length === 0) {
      throw new Error('Training plan validation failed: schedule is empty.');
    }
    if (!Array.isArray(result.nutrition?.days) || result.nutrition.days.length === 0) {
      throw new Error('Nutrition plan validation failed: days array is empty.');
    }

    // Normalize instructions
    if (result.nutrition.days) {
      for (const day of result.nutrition.days) {
        for (const meal of day.meals || []) {
          if (meal.recipe?.instructions) {
            meal.recipe.instructions = PlanService.normalizeInstructions(meal.recipe.instructions);
          }
        }
      }
    }

    // Persist to DB
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { trainingId, mealPlanId } = await PlanService.savePlanToDb(
        client, user.userId, result.training, result.nutrition, body.startDate
      );

      // Auto-archive
      const archiveId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      await client.query(
        `INSERT INTO saved_smart_plans(id, user_id, name, date_created, training, nutrition, progress_day_index, summary)
         VALUES($1, $2, $3, now(), $4, $5, 0, $6)`,
        [archiveId, user.userId, `${result.training.name || 'Smart Plan'} (Coordinated)`, result.training, result.nutrition, `Source: ${result.source}`]
      );

      await client.query('COMMIT');

      // Queue background asset generation (non-blocking)
      try {
        if (result.training.schedule) {
          for (const day of result.training.schedule) {
            for (const ex of day.exercises || []) {
              if (ex.name) {
                await jobProcessor.submitJob(user.userId, 'EXERCISE_GENERATION', {
                  name: ex.name,
                  instructions: ex.instructions,
                  userProfile: profile,
                });
              }
            }
          }
        }
        if (result.nutrition.days) {
          for (const day of result.nutrition.days) {
            for (const meal of day.meals || []) {
              if (meal.recipe?.name) {
                await jobProcessor.submitJob(user.userId, 'MEAL_GENERATION', {
                  name: meal.recipe.name,
                  instructions: meal.recipe.instructions,
                  ingredients: meal.recipe.ingredients,
                });
              }
            }
          }
        }
      } catch (jobErr) {
        req.log.warn({ error: 'Failed to queue background jobs', jobErr, requestId: req.requestId });
      }

      return reply.send({
        training: result.training,
        nutrition: result.nutrition,
        coordination: result.coordination,
        source: result.source,
        trainingId,
        mealPlanId,
        archiveId,
      });
    } catch (e: any) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }));
}
