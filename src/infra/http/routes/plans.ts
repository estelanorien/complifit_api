import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import fetch from 'node-fetch';
import { env } from '../../../config/env';

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string(),
  dateCreated: z.string().optional(),
  training: z.record(z.any()),
  nutrition: z.record(z.any()),
  progressDayIndex: z.number().optional(),
  summary: z.string().optional()
});

const loadSchema = z.object({
  id: z.string().uuid()
});

export async function plansRoutes(app: FastifyInstance) {
  const cleanGeminiJson = (text: string): string => {
    if (!text) return '{}';
    // Find the first '{' and the last '}'
    const callbackOpen = text.indexOf('{');
    const callbackClose = text.lastIndexOf('}');

    if (callbackOpen !== -1 && callbackClose !== -1 && callbackClose > callbackOpen) {
      return text.substring(callbackOpen, callbackClose + 1);
    }

    // Fallback: try cleanup of markdown only if braces not found (unlikely for JSON)
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
    return cleaned;
  };
  const savePlanToDb = async (client: any, userId: string, training: any, nutrition: any, startDate?: string) => {
    const trainingId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await client.query(
      `INSERT INTO training_programs(id, user_id, name, analysis, training_style, is_recovery, created_at)
       VALUES($1,$2,$3,$4,$5,false,now())`,
      [trainingId, userId, training?.name || 'Smart Plan', training?.analysis || '', training?.trainingStyle || 'standard']
    );

    if (Array.isArray(training?.schedule)) {
      for (let i = 0; i < training.schedule.length; i++) {
        const day = training.schedule[i];
        const dayId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
        await client.query(
          `INSERT INTO training_days(id, training_program_id, day_index, focus)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (training_program_id, day_index) DO NOTHING`,
          [dayId, trainingId, i, day.focus || day.day || `Day ${i + 1}`]
        );
        if (Array.isArray(day.exercises)) {
          for (const ex of day.exercises) {
            await client.query(
              `INSERT INTO training_exercises(id, training_day_id, name, sets, reps, notes, target_muscles, equipment, difficulty, metadata, created_at)
               VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
              [
                dayId,
                ex.name || 'Exercise',
                ex.sets || '',
                ex.reps || '',
                ex.notes || ex.drillContext || '',
                ex.targetMuscles || null,
                ex.equipment || null,
                ex.difficulty || null,
                ex
              ]
            );
          }
        }
      }
    }

    const mealPlanId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await client.query(
      `INSERT INTO meal_plans(id, user_id, name, start_date, variety_mode, is_recovery, created_at)
       VALUES($1,$2,$3,$4,$5,false,now())`,
      [mealPlanId, userId, nutrition?.name || 'Smart Meal Plan', startDate || null, nutrition?.varietyMode || null]
    );

    const toJsonOrNull = (val: any) => val === undefined || val === null ? null : JSON.stringify(val);

    if (Array.isArray(nutrition?.days)) {
      for (let i = 0; i < nutrition.days.length; i++) {
        const day = nutrition.days[i];
        const dayId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
        await client.query(
          `INSERT INTO meal_plan_days(id, meal_plan_id, day_index, target_calories)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (meal_plan_id, day_index) DO NOTHING`,
          [dayId, mealPlanId, i, day.targetCalories || null]
        );
        if (Array.isArray(day.meals)) {
          for (const meal of day.meals) {
            await client.query(
              `INSERT INTO meals(id, meal_plan_day_id, type, name, calories, macros, time_label, ingredients, instructions, nutrition_tips, metadata, created_at)
               VALUES(gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, now())`,
              [
                dayId,
                meal.type || 'meal',
                meal.recipe?.name || 'Meal',
                meal.recipe?.calories || meal.calories || null,
                toJsonOrNull(meal.recipe?.macros),
                meal.recipe?.time || null,
                toJsonOrNull(meal.recipe?.ingredients || meal.ingredients || null),
                toJsonOrNull(meal.recipe?.instructions || meal.instructions || null),
                toJsonOrNull(meal.recipe?.nutritionTips || null),
                toJsonOrNull(meal)
              ]
            );
          }
        }
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
  };
  // List archive
  app.get('/plans/archive', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, name, date_created, training, nutrition, progress_day_index, summary
       FROM saved_smart_plans
       WHERE user_id = $1
       ORDER BY date_created DESC
       LIMIT 50`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      training: r.training,
      nutrition: r.nutrition,
      progressDayIndex: r.progress_day_index ?? undefined,
      summary: r.summary ?? undefined
    }));
  });

  // Save archive (upsert by id)
  app.post('/plans/archive', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = saveSchema.parse(req.body);

    // Check for recent duplicate saves (within 5 minutes)
    const recentDuplicate = await pool.query(
      `SELECT id, name FROM saved_smart_plans 
       WHERE user_id = $1 
       AND date_created > NOW() - INTERVAL '5 minutes'
       LIMIT 1`,
      [user.userId]
    );

    if (recentDuplicate.rows.length > 0 && !body.id) {
      // Duplicate found, return warning
      return reply.send({
        id: recentDuplicate.rows[0].id,
        alreadySaved: true,
        message: `Plan "${recentDuplicate.rows[0].name}" was already saved recently`
      });
    }

    const id = body.id || (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    await pool.query(
      `INSERT INTO saved_smart_plans(id, user_id, name, date_created, training, nutrition, progress_day_index, summary)
       VALUES($1,$2,$3,COALESCE($4, now()),$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name,
         date_created=EXCLUDED.date_created,
         training=EXCLUDED.training,
         nutrition=EXCLUDED.nutrition,
         progress_day_index=EXCLUDED.progress_day_index,
         summary=EXCLUDED.summary`,
      [
        id,
        user.userId,
        body.name,
        body.dateCreated || null,
        body.training,
        body.nutrition,
        body.progressDayIndex ?? null,
        body.summary || null
      ]
    );
    return reply.send({ id, alreadySaved: false });
  });

  // Load one and apply to user profile
  app.post('/plans/archive/load', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = loadSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT id, name, date_created, training, nutrition, progress_day_index, summary
       FROM saved_smart_plans
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [body.id, user.userId]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    const r = rows[0];

    // Calculate start date based on progress
    let startDate = new Date().toISOString().split('T')[0];
    if (r.progress_day_index) {
      const d = new Date();
      d.setDate(d.getDate() - r.progress_day_index);
      startDate = d.toISOString().split('T')[0];
    }

    // Apply plan to user profile
    await pool.query(
      `UPDATE user_profiles
       SET profile_data = jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentTrainingProgram}',
           $1::jsonb,
           true
         )
         || jsonb_set(
           COALESCE(profile_data, '{}'::jsonb),
           '{currentMealPlan}',
           $2::jsonb,
           true
         )
         || jsonb_build_object(
           'smartPlanActive', true,
           'trainingProgramStartDate', $3,
           'mealPlanStartDate', $3
         ),
           updated_at = now()
       WHERE user_id = $4`,
      [JSON.stringify(r.training), JSON.stringify(r.nutrition), startDate, user.userId]
    );

    return {
      id: r.id,
      name: r.name,
      dateCreated: r.date_created,
      training: r.training,
      nutrition: r.nutrition,
      progressDayIndex: r.progress_day_index ?? undefined,
      summary: r.summary ?? undefined
    };
  });

  app.delete('/plans/archive/:id', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rowCount } = await pool.query(
      `DELETE FROM saved_smart_plans WHERE id = $1 AND user_id = $2`,
      [params.id, user.userId]
    );
    if (rowCount === 0) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return { success: true };
  });

  // Save a generated plan into relational tables + profile
  app.post('/plans/save-generated', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    const body = z.object({
      training: z.any(),
      nutrition: z.any(),
      startDate: z.string().optional()
    }).parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');

      const { trainingId, mealPlanId } = await savePlanToDb(client, user.userId, body.training, body.nutrition, body.startDate);

      await client.query('COMMIT');
      return reply.send({ trainingId, mealPlanId });
    } catch (e: any) {
      await client.query('ROLLBACK');
      req.log.error({ error: e, requestId: (req as any).requestId }, 'Save generated plan failed');
      return reply.status(500).send({ error: e.message || 'Plan save failed', stack: e?.stack });
    } finally {
      client.release();
    }
  });

  // Helper: Get contraindications from conditions
  const getContraindications = (conditions: string[]): string[] => {
    const bans: string[] = [];
    const conds = conditions.map(c => c.toLowerCase());
    if (conds.some(c => c.includes('plantar') || c.includes('ankle') || c.includes('shin'))) {
      bans.push("NO High Impact (Jump Squats, Box Jumps, Burpees, Running)");
    }
    if (conds.some(c => c.includes('back') || c.includes('disc') || c.includes('sciatica') || c.includes('lumbar'))) {
      bans.push("NO Heavy Spinal Loading (Barbell Back Squat, Conventional Deadlift)");
      bans.push("NO Twisting under load");
    }
    if (conds.some(c => c.includes('knee') || c.includes('meniscus') || c.includes('acl'))) {
      bans.push("NO Deep Flexion under load");
      bans.push("NO High Impact");
    }
    if (conds.some(c => c.includes('shoulder') || c.includes('rotator') || c.includes('impingement'))) {
      bans.push("NO Overhead Pressing");
    }
    return bans;
  };

  // Generate via Gemini on backend and save
  app.post('/plans/generate', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      profile: z.any(),
      settings: z.any(),
      lang: z.string().default('en'),
      startDate: z.string().optional(),
      calculatedBiometrics: z.any().optional() // Frontend'den hesaplanmış değerler
    }).parse(req.body);

    const { profile, settings, lang, calculatedBiometrics } = body;
    const apiKey = env.geminiApiKey;
    const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

    // Extract values
    const focusAreas = profile.focusAreas || [];
    const equipment = profile.equipment || [];
    const excludes = profile.excludedIngredients || [];
    const dietType = settings.dietType || profile.dietaryPreference || 'none';
    const cuisines = profile.preferredCuisines || [];
    const trainingFrequency = settings.frequency || profile.workoutDaysPerWeek || 4;
    const detailedTrainingGoals = profile.specificGoals?.join(', ') || settings.cycleGoal;
    const intensity = settings.intensity || 'moderate';
    const mealStructure = settings.mealFrequency || '3 meals';
    const cookingTime = settings.cookingTime || 'medium';

    const memory = profile.bioMemory;
    const memoryPrompt = memory ? `BIO-MEMORY: ${memory.observations.join('; ')}` : "";

    const contraindications = getContraindications(profile.conditions || []);
    const safetyPrompt = contraindications.length > 0 ? `CONTRAINDICATIONS: ${contraindications.join(', ')}` : "Ensure safety.";

    // Use calculated biometrics from frontend or calculate here
    const tdee = calculatedBiometrics?.tdee || 2000;
    const target = calculatedBiometrics?.target || 2000;
    const safetyFloor = calculatedBiometrics?.safetyFloor || 1200;

    let calorieLogic = `TARGET: ${target} kcal/day. FLOOR: ${safetyFloor} kcal.`;
    if (intensity === 'sprint') {
      calorieLogic = `SPRINT MODE: Aggressive deficit. Target ${Math.max(safetyFloor, Math.round(tdee * 0.75))} kcal. High Protein.`;
    }
    if (intensity === 'peak_week') {
      calorieLogic = `PEAK WEEK: Maintenance calories, high performance carbs.`;
    }

    // Debt Logic Injection
    if (settings.debtStrategy === 'active') {
      calorieLogic += ` DEBT NOTE: User is in debt but paying via activity. DO NOT reduce food calories below target.`;
    } else if (settings.debtStrategy === 'deficit') {
      calorieLogic += ` DEBT NOTE: Prioritize filling, low-calorie density foods to help user adhere to deficit repayment.`;
    } else if (settings.debtStrategy === 'hybrid') {
      calorieLogic += ` DEBT NOTE: Hybrid repayment. Moderate deficit active. Ensure high protein to spare muscle.`;
    } else if (settings.debtStrategy === 'ignore') {
      calorieLogic += ` DEBT NOTE: AMNESTY DECLARED. Ignore any calculated caloric debt. Plan strictly for maintenance/target calories. Do NOT reduce intake for debt repayment.`;
    }

    let mealStructurePrompt = `STRUCTURE: ${mealStructure}.`;
    if (mealStructure === 'omad') mealStructurePrompt += " CONSOLIDATE ALL CALORIES INTO ONE MASSIVE DINNER.";
    if (mealStructure === 'intermittent_fasting') mealStructurePrompt += " Skip Breakfast. Lunch + Dinner + Snack.";
    if (mealStructure === '2 meals') mealStructurePrompt += " Two large meals (Lunch, Dinner). No snacks.";

    let chefStylePrompt = `PREP STYLE: ${cookingTime}.`;
    if (cookingTime === 'mixed') chefStylePrompt = "PREP STYLE: Quick/Easy for Mon-Fri. Gourmet/Elaborate for Sat-Sun.";

    // Inject Debt Burner if Active/Hybrid Strategy
    let debtBurnerPrompt = "";
    if (settings.debtStrategy === 'active') {
      debtBurnerPrompt = `CRITICAL: Add a "Debt Burner" cardio finisher (15 mins low intensity) to EVERY workout session to repay caloric debt.`;
    } else if (settings.debtStrategy === 'hybrid') {
      debtBurnerPrompt = `CRITICAL: Add a "Debt Finisher" cardio block (10 mins) to EVERY workout session.`;
    } else {
      debtBurnerPrompt = `Standard workout structure. No debt repayment obligations.`;
    }

    const durationDays = settings.duration || 7;

    const trainingPrompt = `
    PHASE A (TRAINING - ${durationDays} DAY CYCLE).
    Freq: ${trainingFrequency} Days/Wk.
    Goals: ${detailedTrainingGoals}. Level: ${profile.fitnessLevel}. Intensity: ${intensity}.
    Equipment: ${equipment.join(', ')}. Focus: [${focusAreas.join(', ')}].
    Sports: ${profile.sports?.join(', ') || 'General'}.
    ${memoryPrompt}
    ${safetyPrompt}
    ${debtBurnerPrompt}
    
    IMPORTANT: Distribute the workouts evenly across the ${durationDays} days. Do NOT schedule them all consecutively unless requested. Mark rest days clearly locally but in the output array only include workout days if you prefer, or include Rest days with empty exercises. Ideally, return exactly ${durationDays} items in the schedule array, marking Rest days clearly.
    
    Return JSON with structure: { "name": "...", "analysis": "...", "schedule": [{"day": "Day 1", "focus": "...", "exercises": [{"name": "...", "sets": "3", "reps": "10", "notes": "", "drillContext": ""}]}] }
    Language: ${lang}
    `;

    const nutritionPrompt = `
    PHASE B (NUTRITION - FULL ${durationDays} DAY PLAN).
    Goals: ${settings.nutritionGoal || detailedTrainingGoals}.
    Diet: ${dietType}. Cuisines: ${cuisines.join(', ') || "Global"}.
    ${chefStylePrompt}
    ${mealStructurePrompt}
    ${calorieLogic}
    DEBT NOTE INSTRUCTION: If user is in debt, simply adjust the calories/macros. Do NOT add repetitive text like "Pledge: ..." or "Debt reduction..." to every meal description. Just modify the food itself.
    Excludes: ${excludes.join(', ') || "None"}.
    Language: ${lang}.
    
    PRE-WORKOUT NUTRITION TIMING: If including pre-workout snacks, they should be scheduled 30-60 minutes BEFORE the workout, not hours before. For example, if workout is at 6:00 PM, pre-workout snack should be at 5:00-5:30 PM. Label pre-workout meals with type "pre_workout" and post-workout meals with type "post_workout" to link them with training sessions.
    
    IMPORTANT: You MUST generate a full UNIQUE meal plan for ALL ${durationDays} DAYS. Do not stop at Day 7. The 'days' array must have ${durationDays} items.
    
    OUTPUT JSON ONLY: { "name": "...", "overview": "...", "days": [{"day": "Day 1", "meals": [{"type": "breakfast", "recipe": {"name": "Name", "calories": 500, "time": "15 min", "ingredients": [], "instructions": [{"simple": "Quick instruction (max 15 words)", "detailed": "Detailed instruction with tips (2-3 sentences)"}], "nutritionTips": ["Scientific tip 1", "Scientific tip 2"]}}]}] }
    
    CRITICAL: Each instruction MUST be an object with "simple" and "detailed" fields.
    - "simple": Quick mode (max 15 words).
    - "detailed": Chef mode (2-3 sentences).
    - Use imperative mood.
    `;

    const callGemini = async (prompt: string) => {
      const res = await fetch(genEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }

      let data: any;
      try {
        const rawText = await res.text();
        if (!rawText || rawText.trim() === '') {
          throw new Error('Empty response body from Google API');
        }
        data = JSON.parse(rawText);
      } catch (parseError: any) {
        throw new Error(`Gemini Response Parse Error: ${parseError.message}`);
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) {
        req.log.warn({ requestId: (req as any).requestId, data }, 'Gemini returned no text content candidate');
        // Fallback? No, return empty string which handling logic defaults to {}
      }
      return text;
    };

    try {
      const [trainText, nutText] = await Promise.all([callGemini(trainingPrompt), callGemini(nutritionPrompt)]);
      const trainingPlan = JSON.parse(cleanGeminiJson(trainText) || '{}');
      const nutritionPlan = JSON.parse(cleanGeminiJson(nutText) || '{}');

      if (!Array.isArray(trainingPlan?.schedule) || trainingPlan.schedule.length === 0) {
        return reply.status(500).send({ error: 'Training plan empty from Gemini' });
      }
      if (!Array.isArray(nutritionPlan?.days) || nutritionPlan.days.length === 0) {
        return reply.status(500).send({ error: 'Nutrition plan empty from Gemini' });
      }

      // Check database for existing recipes before processing
      const getExistingRecipe = async (mealName: string): Promise<any | null> => {
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
          req.log.error({ error: `[Plans] Error checking existing recipe for ${mealName}:`, e, requestId: (req as any).requestId });
          return null;
        }
      };

      // Normalize instructions to InstructionBlock format
      const normalizeInstructions = (instructions: any[]): any[] => {
        if (!Array.isArray(instructions)) {
          return [{ simple: 'Enjoy mindfully.', detailed: 'Enjoy this meal mindfully and savor each bite.' }];
        }

        return instructions.map((inst: any) => {
          // If already in InstructionBlock format
          if (typeof inst === 'object' && inst !== null && inst.simple && inst.detailed) {
            return inst;
          }

          // If it's a string, create both simple and detailed versions
          if (typeof inst === 'string') {
            const simple = inst.length > 80 ? inst.substring(0, 80) + '...' : inst;
            return {
              simple: simple,
              detailed: inst
            };
          }

          // Fallback
          return {
            simple: 'Prepare as directed.',
            detailed: 'Follow the recipe instructions carefully.'
          };
        });
      };

      // Process each meal: check database first, then normalize
      if (nutritionPlan?.days) {
        for (const day of nutritionPlan.days) {
          if (Array.isArray(day.meals)) {
            for (const meal of day.meals) {
              const mealName = meal?.recipe?.name;

              if (mealName) {
                // Check database for existing recipe
                const existingRecipe = await getExistingRecipe(mealName);

                if (existingRecipe) {
                  // Use existing recipe from database
                  req.log.info(`[Plans] Using existing recipe from DB: ${mealName}`);
                  meal.recipe.ingredients = existingRecipe.ingredients || meal.recipe.ingredients;
                  meal.recipe.instructions = existingRecipe.instructions || meal.recipe.instructions;
                  meal.recipe.time = existingRecipe.time || meal.recipe.time;
                  meal.recipe.macros = existingRecipe.macros || meal.recipe.macros;
                  meal.recipe.nutritionTips = existingRecipe.nutritionTips || meal.recipe.nutritionTips;
                  if (existingRecipe.calories && !meal.recipe.calories) {
                    meal.recipe.calories = existingRecipe.calories;
                  }
                }
              }

              // Normalize instructions
              if (meal?.recipe?.instructions) {
                meal.recipe.instructions = normalizeInstructions(meal.recipe.instructions);
              } else {
                meal.recipe.instructions = [{ simple: 'Enjoy mindfully.', detailed: 'Enjoy this meal mindfully and savor each bite.' }];
              }
            }
          }
        }
      }

      const client = await pool.connect();
      try {
        await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
        await client.query('BEGIN');
        const { trainingId, mealPlanId } = await savePlanToDb(client, user.userId, trainingPlan, nutritionPlan, body.startDate);

        // Auto-save to archive so user doesn't need to manually save
        // First, check if same plan was saved recently (within 5 minutes) to prevent duplicates
        const recentDuplicate = await client.query(
          `SELECT id FROM saved_smart_plans 
           WHERE user_id = $1 
           AND date_created > NOW() - INTERVAL '5 minutes'
           LIMIT 1`,
          [user.userId]
        );

        let archiveId = null;
        let alreadySaved = false;

        if (recentDuplicate.rows.length > 0) {
          // Plan was recently saved, skip duplicate save
          archiveId = recentDuplicate.rows[0].id;
          alreadySaved = true;
          req.log.info({ requestId: (req as any).requestId }, 'Skipping duplicate archive save - recent plan exists');
        } else {
          // No recent duplicate, save to archive
          archiveId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
          const timestamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          const baseName = trainingPlan?.name || nutritionPlan?.name || 'Smart Plan';
          const archiveName = `${baseName} (${timestamp})`;
          const archiveSummary = `${settings.cycleGoal || 'Fitness'} • ${settings.frequency || 4} Days/Wk • ${settings.duration || 7} Day Cycle`;
          await client.query(
            `INSERT INTO saved_smart_plans(id, user_id, name, date_created, training, nutrition, progress_day_index, summary)
             VALUES($1,$2,$3,now(),$4,$5,0,$6)`,
            [archiveId, user.userId, archiveName, trainingPlan, nutritionPlan, archiveSummary]
          );
        }

        await client.query('COMMIT');
        return reply.send({ training: trainingPlan, nutrition: nutritionPlan, trainingId, mealPlanId, archiveId, alreadySaved });
      } catch (e: any) {
        await client.query('ROLLBACK');
        req.log.error({ error: e, requestId: (req as any).requestId }, 'Generate plan save failed');
        return reply.status(500).send({ error: e.message || 'Plan save failed' });
      } finally {
        client.release();
      }
    } catch (e: any) {
      req.log.error({ error: e, requestId: (req as any).requestId }, 'Gemini generate failed');
      return reply.status(500).send({ error: e.message || 'Gemini generate failed' });
    }
  });

  // Reroll meal via Gemini + log to DB
  app.post('/plans/reroll/meal', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      type: z.string(),
      targetCalories: z.number(),
      profile: z.any(),
      excludes: z.array(z.string()).default([]),
      additionalIngredients: z.string().optional(),
      lang: z.string().default('en'),
      time: z.number().optional(),
      avoidItem: z.string().optional(),
      dayIndex: z.number().optional(),
      mealIndex: z.number().optional()
    }).parse(req.body);

    const prompt = `Suggest ONE alternative ${body.type} recipe (~${body.targetCalories} kcal).
    Diet: ${body.profile?.dietaryPreference || 'none'}. Excludes: ${body.excludes.join(', ') || 'none'}.
    ${body.additionalIngredients ? `MUST include: ${body.additionalIngredients}.` : ''}
    ${body.avoidItem ? `MUST NOT INCLUDE: ${body.avoidItem}. User explicitly rejected this item. Pivot flavor profile.` : ''}
    Language: ${body.lang}.
    
    Return JSON object (Meal structure): 
    { 
      "type": "...", 
      "recipe": { 
        "name": "...", 
        "calories": number, 
        "time": "string", 
        "ingredients": [], 
        "instructions": [
          {
            "simple": "Quick 1-sentence instruction (max 15 words, imperative mood)",
            "detailed": "Detailed step-by-step instruction with chef tips, timing, and technique notes (2-3 sentences)"
          }
        ],
        "nutritionTips": [
          "Scientific tip for maximizing nutrients (e.g., 'Crush garlic 10 minutes before cooking to activate allicin')",
          "Part-specific tip (e.g., 'Eat broccoli stems too - they contain more fiber than florets')"
        ]
      } 
    }
    
    CRITICAL: Each instruction MUST be an object with "simple" and "detailed" fields:
    - "simple": Quick mode - Brief, actionable (max 15 words). Example: "Heat oil in pan, add onions, cook 5 min"
    - "detailed": Chef mode - Detailed with technique, timing, tips (2-3 sentences). Example: "Heat 2 tbsp olive oil in a large skillet over medium heat. Add diced onions and cook, stirring occasionally, until translucent and fragrant (about 5 minutes). This builds the flavor base for the dish."
    - Use imperative mood (no "you should", just "Heat", "Add", "Cook")
    - NO conversational fillers like "Here's how", "First", "Then"
    
    NUTRITION TIPS (nutritionTips array):
    - Provide 2-3 evidence-based tips for maximizing nutritional benefits from this meal
    - Examples:
      * Cooking method tips: "Steam broccoli instead of boiling to preserve 90% of vitamin C"
      * Timing tips: "Crush garlic 10 minutes before cooking to activate allicin, a powerful antioxidant"
      * Part-specific tips: "Eat broccoli stems - they contain 2x more fiber than florets"
      * Combination tips: "Pair spinach with lemon juice - vitamin C increases iron absorption by 3x"
      * Preparation tips: "Soak beans overnight to reduce phytic acid and improve mineral absorption"
    - Keep each tip concise (1 sentence, max 20 words)
    - Base tips on real nutritional science, not generic advice
    `;

    const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';
    const callGemini = async () => {
      const res = await fetch(genEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return text;
    };

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');

      // First, try to find a matching meal in database based on type and calories
      // This prevents generating duplicate recipes
      const existingMealResult = await client.query(
        `SELECT name, ingredients, instructions, time_label, macros, calories, nutrition_tips
         FROM meals
         WHERE type = $1 
           AND calories BETWEEN $2 - 50 AND $2 + 50
         ORDER BY created_at DESC
         LIMIT 1`,
        [body.type, body.targetCalories]
      );

      let meal: any = null;

      if (existingMealResult.rows.length > 0 && !body.avoidItem) {
        // Use existing recipe from database if it matches and user didn't explicitly avoid it
        const existing = existingMealResult.rows[0];
        req.log.info(`[Plans] Using existing recipe from DB for reroll: ${existing.name}`);
        meal = {
          type: body.type,
          recipe: {
            name: existing.name,
            calories: existing.calories,
            time: existing.time_label || '15 min',
            ingredients: existing.ingredients ? (typeof existing.ingredients === 'string' ? JSON.parse(existing.ingredients) : existing.ingredients) : [],
            instructions: existing.instructions ? (typeof existing.instructions === 'string' ? JSON.parse(existing.instructions) : existing.instructions) : [],
            macros: existing.macros ? (typeof existing.macros === 'string' ? JSON.parse(existing.macros) : existing.macros) : null,
            nutritionTips: existing.nutrition_tips ? (typeof existing.nutrition_tips === 'string' ? JSON.parse(existing.nutrition_tips) : existing.nutrition_tips) : null
          }
        };
      } else {
        // Generate new meal if not found in database or user wants to avoid it
        const text = await callGemini();
        meal = JSON.parse(cleanGeminiJson(text) || '{}');
        if (!meal?.recipe?.name) {
          await client.query('ROLLBACK');
          return reply.status(500).send({ error: 'Empty meal from Gemini' });
        }

        // Check if the generated meal already exists in database
        const existingRecipeResult = await client.query(
          `SELECT name, ingredients, instructions, time_label, macros, calories, nutrition_tips
           FROM meals
           WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
           ORDER BY created_at DESC
           LIMIT 1`,
          [meal.recipe.name]
        );

        if (existingRecipeResult.rows.length > 0) {
          // Use existing recipe from database instead of generated one
          const existing = existingRecipeResult.rows[0];
          req.log.info(`[Plans] Generated meal already exists in DB, using existing: ${meal.recipe.name}`);
          meal.recipe.ingredients = existing.ingredients ? (typeof existing.ingredients === 'string' ? JSON.parse(existing.ingredients) : existing.ingredients) : meal.recipe.ingredients;
          meal.recipe.instructions = existing.instructions ? (typeof existing.instructions === 'string' ? JSON.parse(existing.instructions) : existing.instructions) : meal.recipe.instructions;
          meal.recipe.time = existing.time_label || meal.recipe.time;
          meal.recipe.macros = existing.macros ? (typeof existing.macros === 'string' ? JSON.parse(existing.macros) : existing.macros) : meal.recipe.macros;
          meal.recipe.nutritionTips = existing.nutrition_tips ? (typeof existing.nutrition_tips === 'string' ? JSON.parse(existing.nutrition_tips) : existing.nutrition_tips) : meal.recipe.nutritionTips;
          if (existing.calories && !meal.recipe.calories) {
            meal.recipe.calories = existing.calories;
          }
        }
      }

      // Normalize instructions to InstructionBlock format
      const normalizeInstructions = (instructions: any[]): any[] => {
        if (!Array.isArray(instructions)) {
          return [{ simple: 'Enjoy mindfully.', detailed: 'Enjoy this meal mindfully and savor each bite.' }];
        }

        return instructions.map((inst: any) => {
          // If already in InstructionBlock format
          if (typeof inst === 'object' && inst !== null && inst.simple && inst.detailed) {
            return inst;
          }

          // If it's a string, create both simple and detailed versions
          if (typeof inst === 'string') {
            const simple = inst.length > 80 ? inst.substring(0, 80) + '...' : inst;
            return {
              simple: simple,
              detailed: inst
            };
          }

          // Fallback
          return {
            simple: 'Prepare as directed.',
            detailed: 'Follow the recipe instructions carefully.'
          };
        });
      };

      if (meal?.recipe?.instructions) {
        meal.recipe.instructions = normalizeInstructions(meal.recipe.instructions);
      } else {
        meal.recipe.instructions = [{ simple: 'Enjoy mindfully.', detailed: 'Enjoy this meal mindfully and savor each bite.' }];
      }

      // Log reroll to DB
      await client.query(
        `INSERT INTO food_logs_simple(user_id, name, calories, protein, carbs, fat, status, match_accuracy, timestamp, linked_plan_item_id, image_url, metadata)
         VALUES($1,$2,$3,$4,$5,$6,'reroll',NULL,now(),NULL,NULL,$7)`,
        [
          user.userId,
          meal.recipe?.name || 'Meal',
          meal.recipe?.calories || null,
          null,
          null,
          null,
          JSON.stringify({
            type: body.type,
            targetCalories: body.targetCalories,
            additionalIngredients: body.additionalIngredients,
            avoidItem: body.avoidItem,
            dayIndex: body.dayIndex,
            mealIndex: body.mealIndex,
            result: meal
          })
        ]
      );

      await client.query('COMMIT');
      return reply.send({ meal });
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => { }); // Ignore if already rolled back
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: "reroll meal failed", e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: isProduction ? 'Meal reroll service unavailable' : (e.message || 'Reroll meal failed') });
    } finally {
      client.release();
    }
  });

  // Reroll exercise via Gemini + log to DB
  app.post('/plans/reroll/exercise', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      currentName: z.string(),
      focus: z.string(),
      profile: z.any(),
      lang: z.string().default('en'),
      constraint: z.string().optional(),
      safe: z.boolean().optional(),
      style: z.string().optional(),
      healthMetrics: z.any().optional(),
      category: z.string().optional(),
      avoidItem: z.string().optional(),
      dayIndex: z.number().optional(),
      exerciseIndex: z.number().optional()
    }).parse(req.body);

    let prompt = "";
    if (body.constraint === 'equipment_busy') {
      prompt = `
      TASK: EQUIPMENT SUBSTITUTION.
      User cannot perform "${body.currentName}" (Equipment Busy).
      Find a substitute that targets the SAME muscles using DIFFERENT equipment from: ${(body.profile?.equipment || []).join(', ')}.
      Language: ${body.lang}.
      Return JSON object: { "name": "...", "sets": "...", "reps": "...", "notes": "Substitute for ${body.currentName}" }
      `;
    } else {
      prompt = `Suggest ONE alternative exercise to replace "${body.currentName}" for a "${body.focus}" workout.
      Level: ${body.profile?.fitnessLevel}. Goal: ${(body.profile?.specificGoals || []).join(', ') || body.profile?.primaryGoal || ''}.
      Equipment: ${(body.profile?.equipment || []).join(', ')}.
      Conditions: ${(body.profile?.conditions || []).join(', ')}.
      ${body.constraint ? `USER REQUEST/CONSTRAINT: ${body.constraint}.` : ''}
      ${body.avoidItem ? `MUST AVOID: ${body.avoidItem}. User dislikes this.` : ''}
      ${body.safe ? "Prioritize safety." : ""}
      Language: ${body.lang}.
      Notes field: Technical, concise (under 10 words). DO NOT use conversational filler like "Here is" or "Sure".
      Return JSON object: { "name": "...", "sets": "...", "reps": "...", "notes": "..." }
      `;
    }

    const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';
    const callGemini = async () => {
      const res = await fetch(genEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return text;
    };

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');

      const text = await callGemini();
      const ex = JSON.parse(cleanGeminiJson(text) || '{}');
      if (!ex?.name) {
        await client.query('ROLLBACK');
        return reply.status(500).send({ error: 'Empty exercise from Gemini' });
      }

      const setsNum = parseInt(ex.sets) || 3;
      const estCal = ex.estimatedCalories || null;

      await client.query(
        `INSERT INTO exercise_logs_simple(user_id, name, date, sets, location, estimated_calories, verification, is_negotiated)
         VALUES($1, $2, now()::date, $3, NULL, $4, $5, false)`,
        [
          user.userId,
          ex.name,
          JSON.stringify([{ sets: ex.sets, reps: ex.reps, notes: ex.notes, focus: body.focus, constraint: body.constraint, avoidItem: body.avoidItem }]),
          estCal,
          JSON.stringify({ dayIndex: body.dayIndex, exerciseIndex: body.exerciseIndex, input: body, result: ex })
        ]
      );

      await client.query('COMMIT');
      return reply.send({ exercise: ex });
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => { }); // Ignore if already rolled back
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: "reroll exercise failed", e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: isProduction ? 'Exercise reroll service unavailable' : (e.message || 'Reroll exercise failed') });
    } finally {
      client.release();
    }
  });

  // Smart Refactor - AI-powered redistribution of missed items into existing plan
  app.post('/plans/smart-refactor', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const bodySchema = z.object({
      missedCalories: z.number(),
      missedWorkouts: z.number(),
      currentDayIndex: z.number(), // Which day of the plan user is on (0-indexed)
      currentTrainingPlan: z.any(), // The user's current training plan
      currentNutritionPlan: z.any(), // The user's current meal plan
      userProfile: z.object({
        fitnessLevel: z.string().optional(),
        primaryGoal: z.string().optional(),
        dietaryPreference: z.string().optional()
      }).optional()
    });

    const body = bodySchema.parse(req.body);
    const { missedCalories, missedWorkouts, currentDayIndex, currentTrainingPlan, currentNutritionPlan, userProfile } = body;

    // Calculate remaining days in the plan
    const totalTrainingDays = currentTrainingPlan?.schedule?.length || 7;
    const totalNutritionDays = currentNutritionPlan?.days?.length || 7;
    const remainingDays = Math.max(totalTrainingDays, totalNutritionDays) - currentDayIndex - 1;

    if (remainingDays <= 0) {
      return reply.status(400).send({ error: 'No remaining days in plan to redistribute items' });
    }

    // Safety limits
    const MAX_EXTRA_CALORIES_PER_DAY = 200; // Smaller daily adjustment for in-plan distribution
    const MAX_EXTRA_SETS_PER_DAY = 3; // Extra sets, not whole exercises

    const prompt = `
    You are a certified fitness coach. A user has skipped today's items and needs them redistributed SAFELY into their remaining plan.

    MISSED TODAY:
    - Calories: ${missedCalories} kcal (meals skipped)
    - Workouts: ${missedWorkouts} session(s)

    CURRENT PLAN DETAILS:
    - Current day: ${currentDayIndex + 1} of ${Math.max(totalTrainingDays, totalNutritionDays)}
    - Remaining days: ${remainingDays}
    - Training schedule has ${totalTrainingDays} days
    - Nutrition plan has ${totalNutritionDays} days

    USER PROFILE:
    - Fitness Level: ${userProfile?.fitnessLevel || 'intermediate'}
    - Goal: ${userProfile?.primaryGoal || 'general fitness'}
    - Diet: ${userProfile?.dietaryPreference || 'balanced'}

    MUSCLE GROUP RECOVERY SCIENCE (FOLLOW STRICTLY):
    - Muscle groups need 48-72 hours recovery before training again
    - DIFFERENT muscle groups CAN be trained on consecutive days
    - Examples of compatible pairings (can add exercises to these days):
      * Leg exercises → Chest/Back/Shoulder days (safe - different muscles)
      * Chest exercises → Leg/Back days (safe)
      * Back exercises → Chest/Leg days (safe)  
      * Arm exercises → Any non-arm day (safe)
    - NEVER add exercises to a day training the SAME muscle group
    - Compound exercises (squats, deadlifts, bench) are more taxing - limit to 2-3 extra sets
    - Isolation exercises (curls, extensions) are less taxing - can add 3-4 extra sets
    
    REST DAY RULES:
    - REST days can receive light-moderate exercises from missed sessions
    - Don't turn a rest day into a full intense workout
    - Max 1 compound exercise OR 2-3 isolation exercises on rest days

    SAFETY CONSTRAINTS:
    1. Max ${MAX_EXTRA_CALORIES_PER_DAY} kcal extra per day (spread deficit evenly)
    2. Max ${MAX_EXTRA_SETS_PER_DAY} extra sets per day on training days
    3. Prioritize adding to days with NON-OVERLAPPING muscle groups first
    4. If rest day, keep additions light (max 15-20 min extra work)
    5. Never exceed user's fitness level capabilities
    6. If can't redistribute safely, leave items unrecovered - health first

    TASK: Analyze the missed exercises and redistribute them to compatible training days OR rest days in the remaining plan.

    OUTPUT JSON ONLY:
    {
      "summary": "Brief explanation of how missed items are being redistributed",
      "safetyNote": "Important health reminder for the user",
      "canFullyRecover": <boolean>,
      "unrecoverableCalories": <number - calories that can't be safely recovered>,
      "unrecoverableWorkouts": <number - workouts that can't fit safely>,
      "modifications": [
        {
          "dayIndex": <number - 0-indexed day of plan to modify>,
          "type": "nutrition" | "training",
          "action": "increase_calories" | "add_exercise" | "increase_sets",
          "amount": <number - calories to add OR sets to add>,
          "note": "Brief explanation"
        }
      ]
    }
    `;

    try {
      const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';
      const res = await fetch(`${genEndpoint}?key=${env.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        req.log.error({ error: errText }, 'Gemini smart-refactor failed');
        return reply.status(500).send({ error: 'AI service unavailable' });
      }

      const data = await res.json() as any;
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!text) {
        return reply.status(500).send({ error: 'Empty response from AI' });
      }

      const refactorResult = JSON.parse(cleanGeminiJson(text));

      // Validate and cap modifications for safety
      if (refactorResult.modifications) {
        for (const mod of refactorResult.modifications) {
          if (mod.type === 'nutrition' && mod.amount > MAX_EXTRA_CALORIES_PER_DAY) {
            mod.amount = MAX_EXTRA_CALORIES_PER_DAY;
            mod.note = `(Capped at ${MAX_EXTRA_CALORIES_PER_DAY} kcal for safety) ${mod.note || ''}`;
          }
          if (mod.type === 'training' && mod.action === 'increase_sets' && mod.amount > MAX_EXTRA_SETS_PER_DAY) {
            mod.amount = MAX_EXTRA_SETS_PER_DAY;
          }
        }
      }

      // Log the refactor action
      await pool.query(
        `INSERT INTO activity_logs(id, user_id, action, metadata, created_at)
         VALUES(gen_random_uuid(), $1, 'smart_refactor', $2, now())`,
        [user.userId, JSON.stringify({ currentDayIndex, missedCalories, missedWorkouts, result: refactorResult })]
      );

      return reply.send({
        success: true,
        refactorPlan: refactorResult,
        appliedAt: new Date().toISOString()
      });

    } catch (e: any) {
      req.log.error({ error: e }, 'Smart refactor failed');
      return reply.status(500).send({ error: e.message || 'Smart refactor failed' });
    }
  });
}

