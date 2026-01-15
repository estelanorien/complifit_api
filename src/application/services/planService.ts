import { pool } from '../../infra/db/pool.js';

export class PlanService {
    /**
     * Cleans Gemini JSON response by removing markdown blocks.
     */
    static cleanGeminiJson(text: string): string {
        if (!text) return '';
        return text.replace(/```json\n?|```/g, '').replace(/^[^{]*/, '').replace(/[^}]*$/, '').trim();
    }

    /**
     * Normalizes instruction arrays to a standard InstructionBlock format.
     */
    static normalizeInstructions(instructions: any[]): any[] {
        if (!Array.isArray(instructions)) {
            return [{ simple: 'Enjoy mindfully.', detailed: 'Enjoy this meal mindfully and savor each bite.' }];
        }

        return instructions.map((inst: any) => {
            if (typeof inst === 'object' && inst !== null && inst.simple && inst.detailed) {
                return inst;
            }

            if (typeof inst === 'string') {
                const simple = inst.length > 80 ? inst.substring(0, 80) + '...' : inst;
                return {
                    simple: simple,
                    detailed: inst
                };
            }

            return {
                simple: 'Prepare as directed.',
                detailed: 'Follow the recipe instructions carefully.'
            };
        });
    }

    /**
     * Checks the database for an existing recipe by name.
     */
    static async getExistingRecipe(mealName: string): Promise<any | null> {
        try {
            const result = await pool.query(
                `SELECT name, ingredients, instructions, time_label, macros, calories, nutrition_tips
         FROM meals
         WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         ORDER BY created_at DESC
         LIMIT 1`,
                [mealName]
            );

            if (result.rows.length > 0) {
                const existing = result.rows[0];
                return {
                    ingredients: existing.ingredients ? (typeof existing.ingredients === 'string' ? JSON.parse(existing.ingredients) : existing.ingredients) : null,
                    instructions: existing.instructions ? (typeof existing.instructions === 'string' ? JSON.parse(existing.instructions) : existing.instructions) : null,
                    time: existing.time_label,
                    macros: existing.macros ? (typeof existing.macros === 'string' ? JSON.parse(existing.macros) : existing.macros) : null,
                    calories: existing.calories,
                    nutritionTips: existing.nutrition_tips ? (typeof existing.nutrition_tips === 'string' ? JSON.parse(existing.nutrition_tips) : existing.nutrition_tips) : null
                };
            }
            return null;
        } catch (e) {
            console.error(`[PlanService] Error checking existing recipe for ${mealName}:`, e);
            return null;
        }
    }

    /**
     * Saves a complete smart plan (training + nutrition) to the database.
     */
    static async savePlanToDb(client: any, userId: string, training: any, nutrition: any, startDate?: string) {
        const toJsonOrNull = (val: any) => val === undefined || val === null ? null : JSON.stringify(val);

        // --- Training Program ---
        const trainingIdRes = await client.query('SELECT gen_random_uuid() AS id');
        const trainingId = trainingIdRes.rows[0].id;

        await client.query(
            `INSERT INTO training_programs(id, user_id, name, analysis, training_style, is_recovery, created_at)
       VALUES($1,$2,$3,$4,$5,false,now())`,
            [trainingId, userId, training?.name || 'Smart Plan', training?.analysis || '', training?.trainingStyle || 'standard']
        );

        if (Array.isArray(training?.schedule) && training.schedule.length > 0) {
            const dayIds: string[] = [];
            const dayIndices: number[] = [];
            const dayFocuses: string[] = [];

            for (let i = 0; i < training.schedule.length; i++) {
                const day = training.schedule[i];
                const dayIdRes = await client.query('SELECT gen_random_uuid() AS id');
                const dayId = dayIdRes.rows[0].id;
                dayIds.push(dayId);
                dayIndices.push(i);
                dayFocuses.push(day.focus || day.day || `Day ${i + 1}`);
            }

            await client.query(
                `INSERT INTO training_days(id, training_program_id, day_index, focus)
         SELECT unnest($1::uuid[]), $2, unnest($3::int[]), unnest($4::text[])
         ON CONFLICT (training_program_id, day_index) DO NOTHING`,
                [dayIds, trainingId, dayIndices, dayFocuses]
            );

            const exDayIds: string[] = [];
            const exNames: string[] = [];
            const exSets: string[] = [];
            const exReps: string[] = [];
            const exNotes: string[] = [];
            const exTargetMuscles: (string[] | null)[] = [];
            const exEquipment: (string[] | null)[] = [];
            const exDifficulty: (string | null)[] = [];
            const exMetadata: string[] = [];

            for (let i = 0; i < training.schedule.length; i++) {
                const day = training.schedule[i];
                const dayId = dayIds[i];
                if (Array.isArray(day.exercises)) {
                    for (const ex of day.exercises) {
                        exDayIds.push(dayId);
                        exNames.push(ex.name || 'Exercise');
                        exSets.push(ex.sets || '');
                        exReps.push(ex.reps || '');
                        exNotes.push(ex.notes || ex.drillContext || '');
                        // Convert targetMuscles to array format (text[]) - handle both string and array
                        exTargetMuscles.push(
                            Array.isArray(ex.targetMuscles) 
                                ? ex.targetMuscles 
                                : (ex.targetMuscles ? [ex.targetMuscles] : null)
                        );
                        // Convert equipment to array format (text[]) - handle both string and array
                        exEquipment.push(
                            Array.isArray(ex.equipment) 
                                ? ex.equipment 
                                : (ex.equipment ? [ex.equipment] : null)
                        );
                        exDifficulty.push(ex.difficulty || null);
                        exMetadata.push(JSON.stringify(ex));
                    }
                }
            }

            if (exDayIds.length > 0) {
                // Insert exercises one by one to properly handle array columns (target_muscles, equipment)
                // This is necessary because PostgreSQL requires proper array type handling
                for (let i = 0; i < exDayIds.length; i++) {
                    await client.query(
                        `INSERT INTO training_exercises(id, training_day_id, name, sets, reps, notes, target_muscles, equipment, difficulty, metadata, created_at)
             VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
                        [
                            exDayIds[i],
                            exNames[i],
                            exSets[i],
                            exReps[i],
                            exNotes[i],
                            exTargetMuscles[i], // Already converted to array or null
                            exEquipment[i],
                            exDifficulty[i],
                            exMetadata[i]
                        ]
                    );
                }
            }
        }

        // --- Meal Plan ---
        const mealPlanIdRes = await client.query('SELECT gen_random_uuid() AS id');
        const mealPlanId = mealPlanIdRes.rows[0].id;

        await client.query(
            `INSERT INTO meal_plans(id, user_id, name, start_date, variety_mode, is_recovery, created_at)
       VALUES($1,$2,$3,$4,$5,false,now())`,
            [mealPlanId, userId, nutrition?.name || 'Smart Meal Plan', startDate || null, nutrition?.varietyMode || null]
        );

        if (Array.isArray(nutrition?.days) && nutrition.days.length > 0) {
            const mealDayIds: string[] = [];
            const mealDayIndices: number[] = [];
            const mealDayCalories: (number | null)[] = [];

            for (let i = 0; i < nutrition.days.length; i++) {
                const day = nutrition.days[i];
                const dayIdRes = await client.query('SELECT gen_random_uuid() AS id');
                const dayId = dayIdRes.rows[0].id;
                mealDayIds.push(dayId);
                mealDayIndices.push(i);
                mealDayCalories.push(day.targetCalories || null);
            }

            await client.query(
                `INSERT INTO meal_plan_days(id, meal_plan_id, day_index, target_calories)
         SELECT unnest($1::uuid[]), $2, unnest($3::int[]), unnest($4::int[])
         ON CONFLICT (meal_plan_id, day_index) DO NOTHING`,
                [mealDayIds, mealPlanId, mealDayIndices, mealDayCalories]
            );

            const mDayIds: string[] = [];
            const mTypes: string[] = [];
            const mNames: string[] = [];
            const mCalories: (number | null)[] = [];
            const mMacros: string[] = [];
            const mTimeLabels: (string | null)[] = [];
            const mIngredients: string[] = [];
            const mInstructions: string[] = [];
            const mNutritionTips: string[] = [];
            const mMetadata: string[] = [];

            for (let i = 0; i < nutrition.days.length; i++) {
                const day = nutrition.days[i];
                const dayId = mealDayIds[i];
                if (Array.isArray(day.meals)) {
                    for (const meal of day.meals) {
                        mDayIds.push(dayId);
                        mTypes.push(meal.type || 'meal');
                        mNames.push(meal.recipe?.name || 'Meal');
                        mCalories.push(meal.recipe?.calories || meal.calories || null);
                        mMacros.push(toJsonOrNull(meal.recipe?.macros) || '{}');
                        mTimeLabels.push(meal.recipe?.time || null);
                        mIngredients.push(toJsonOrNull(meal.recipe?.ingredients || meal.ingredients || null) || '[]');
                        mInstructions.push(toJsonOrNull(meal.recipe?.instructions || meal.instructions || null) || '[]');
                        mNutritionTips.push(toJsonOrNull(meal.recipe?.nutritionTips || null) || '[]');
                        mMetadata.push(toJsonOrNull(meal) || '{}');
                    }
                }
            }

            if (mDayIds.length > 0) {
                await client.query(
                    `INSERT INTO meals(id, meal_plan_day_id, type, name, calories, macros, time_label, ingredients, instructions, nutrition_tips, metadata, created_at)
           SELECT gen_random_uuid(), unnest($1::uuid[]), unnest($2::text[]), unnest($3::text[]), unnest($4::int[]), unnest($5::jsonb[]), unnest($6::text[]), unnest($7::jsonb[]), unnest($8::jsonb[]), unnest($9::jsonb[]), unnest($10::jsonb[]), now()`,
                    [mDayIds, mTypes, mNames, mCalories, mMacros, mTimeLabels, mIngredients, mInstructions, mNutritionTips, mMetadata]
                );
            }
        }

        await client.query(
            `UPDATE user_profiles
       SET profile_data = jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentTrainingProgram}',
           $1::jsonb,
           true
         )
         || jsonb_build_object(
           'currentMealPlan', $2::jsonb,
           'trainingProgramStartDate', COALESCE($3, to_char(now(),'YYYY-MM-DD')),
           'mealPlanStartDate', COALESCE($3, to_char(now(),'YYYY-MM-DD'))
         ),
           updated_at = now()
       WHERE user_id = $4`,
            [JSON.stringify(training), JSON.stringify(nutrition), startDate || null, userId]
        );

        return { trainingId, mealPlanId };
    }

    /**
     * Generates a string of contraindications based on a list of health conditions.
     */
    static getContraindications(conditions: string[]): string[] {
        const list: string[] = [];
        conditions.forEach(c => {
            const lower = c.toLowerCase();
            if (lower.includes('heart')) list.push('Avoid extreme intensity, prioritize low-HR steady state.');
            if (lower.includes('diabetes')) list.push('Monitor glucose, prioritize low-GI meal timing.');
            if (lower.includes('asthma')) list.push('Warm-up extensively, emphasize humid environments if possible.');
            if (lower.includes('hypertension')) list.push('Avoid long isometric holds or valsalva maneuver.');
            if (lower.includes('obesity')) list.push('Prioritize low-impact modalities to protect joints.');
            if (lower.includes('pregnancy')) list.push('Avoid supine exercises after 1st trimester, prioritize pelvic floor.');
        });
        return list;
    }
}
