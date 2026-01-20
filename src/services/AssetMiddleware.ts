import { AssetGenerationFacade } from '../application/services/AssetGenerationFacade.js';
import { pool } from '../infra/db/pool.js';

/**
 * AssetMiddleware - Handles on-demand asset generation for user plans
 * 
 * When AI prescribes exercises or meals to users, this middleware ensures
 * assets exist. Generation happens asynchronously and doesn't block plan creation.
 */
export class AssetMiddleware {

    /**
     * Ensure assets exist for all exercises in a training plan
     * Fire-and-forget - doesn't block plan creation
     */
    static async ensureTrainingPlanAssets(exercises: any[]): Promise<void> {
        if (!Array.isArray(exercises) || exercises.length === 0) {
            return;
        }

        console.log(`[AssetMiddleware] Ensuring assets for ${exercises.length} exercises`);

        for (const exercise of exercises) {
            try {
                // Get or create exercise ID
                const exerciseId = await this.getOrCreateExerciseId(exercise.name);

                if (exerciseId) {
                    // Fire and forget - don't await
                    AssetGenerationFacade.ensureAssets('ex', exerciseId);
                }
            } catch (e: any) {
                console.error(`[AssetMiddleware] Failed to ensure assets for exercise: ${exercise.name}`, e.message);
                // Continue with other exercises
            }
        }
    }

    /**
     * Ensure assets exist for all meals in a meal plan
     * Fire-and-forget - doesn't block plan creation
     */
    static async ensureMealPlanAssets(meals: any[]): Promise<void> {
        if (!Array.isArray(meals) || meals.length === 0) {
            return;
        }

        console.log(`[AssetMiddleware] Ensuring assets for ${meals.length} meals`);

        for (const meal of meals) {
            try {
                // Get or create meal ID
                const mealId = await this.getOrCreateMealId(meal.name);

                if (mealId) {
                    // Fire and forget - don't await
                    AssetGenerationFacade.ensureAssets('meal', mealId);
                }
            } catch (e: any) {
                console.error(`[AssetMiddleware] Failed to ensure assets for meal: ${meal.name}`, e.message);
                // Continue with other meals
            }
        }
    }

    /**
     * Get existing exercise ID or create new exercise entry
     */
    private static async getOrCreateExerciseId(exerciseName: string): Promise<string | null> {
        if (!exerciseName) return null;

        try {
            // Check if exercise exists
            const existing = await pool.query(
                `SELECT id FROM training_exercises WHERE LOWER(name) = LOWER($1) LIMIT 1`,
                [exerciseName]
            );

            if (existing.rows.length > 0) {
                return existing.rows[0].id;
            }

            // Create new exercise entry
            const newExercise = await pool.query(
                `INSERT INTO training_exercises (id, name, created_at)
                 VALUES (gen_random_uuid(), $1, now())
                 RETURNING id`,
                [exerciseName]
            );

            console.log(`[AssetMiddleware] Created new exercise: ${exerciseName}`);
            return newExercise.rows[0].id;

        } catch (e: any) {
            console.error(`[AssetMiddleware] Error getting/creating exercise ID:`, e.message);
            return null;
        }
    }

    /**
     * Get existing meal ID or create new meal entry
     */
    private static async getOrCreateMealId(mealName: string): Promise<string | null> {
        if (!mealName) return null;

        try {
            // Check if meal exists
            const existing = await pool.query(
                `SELECT id FROM meals WHERE LOWER(name) = LOWER($1) LIMIT 1`,
                [mealName]
            );

            if (existing.rows.length > 0) {
                return existing.rows[0].id;
            }

            // Create new meal entry
            const newMeal = await pool.query(
                `INSERT INTO meals (id, name, created_at)
                 VALUES (gen_random_uuid(), $1, now())
                 RETURNING id`,
                [mealName]
            );

            console.log(`[AssetMiddleware] Created new meal: ${mealName}`);
            return newMeal.rows[0].id;

        } catch (e: any) {
            console.error(`[AssetMiddleware] Error getting/creating meal ID:`, e.message);
            return null;
        }
    }
}
