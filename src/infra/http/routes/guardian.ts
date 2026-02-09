import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AiService } from '../../../application/services/aiService.js';
import { AuthenticatedRequest } from '../types.js';

const ai = new AiService();

// Helper to find meal ID in profile plan
const findMealIdOrName = (profileData: any, dateStr: string, targetName: string): string | null => {
  if (!profileData.currentMealPlan || !profileData.mealPlanStartDate) return null;

  try {
    const startDate = new Date(profileData.mealPlanStartDate);
    const targetDate = new Date(dateStr);
    const dayDiff = Math.floor((targetDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    // Check if day index is valid (roughly) - assuming weekly rotation or linear
    // For simple weekly plan:
    const dayIndex = dayDiff >= 0 ? dayDiff % 7 : -1;

    if (dayIndex >= 0 && profileData.currentMealPlan.days[dayIndex]) {
      const dayMeals = profileData.currentMealPlan.days[dayIndex].meals;
      // Search by type or name fuzzy match
      const foundIdx = dayMeals.findIndex((m: any) =>
        (m.type && m.type.toLowerCase() === targetName.toLowerCase()) ||
        (m.name && m.name.toLowerCase().includes(targetName.toLowerCase()))
      );

      if (foundIdx >= 0) {
        return `meal-${dayIndex}-${foundIdx}`; // ID format used in frontend
      }
    }
  } catch (e) {
    return null;
  }
  return null;
};

export async function guardianRoutes(app: FastifyInstance) {
  // Analyze deletion impact
  app.post('/guardian/analyze-deletion', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    const body = z.object({
      type: z.enum(['training', 'meal']),
      title: z.string(),
      calories: z.number(),
      profile: z.any(), // TODO: define UserProfile schema
      remainingItems: z.number(),
      lang: z.string().default('en'),
      recentLogs: z.array(z.string()).default([]),
      tomorrowContext: z.string().default('Normal day'),
      currentNetState: z.number().optional(),
      availableMeals: z.array(z.string()).default([]) // New: Names of available meals today
    }).parse(req.body);

    const { type, title, calories, profile, remainingItems, lang, recentLogs, tomorrowContext, currentNetState, availableMeals } = body;

    const isDeficit = currentNetState && currentNetState < 0;

    const prompt = `
    ACT AS GUARDIAN AI - A BIOLOGICAL SAFETY NET.
    User wants to delete ${type}: "${title}" (${calories} cal).
    
    LIVE CONTEXT:
    - Primary Goal: ${profile.primaryGoal || 'maintain'}.
    - Net State: ${currentNetState ? (isDeficit ? 'Deficit' : 'Surplus') + ' ' + Math.abs(currentNetState) + 'kcal' : 'Balanced'}.
    - Remaining items today: ${remainingItems}.
    - Available Meals Later: ${availableMeals.join(', ') || 'None'}.
    - Recent Logs: ${recentLogs.join(', ') || "None"}.
    - Tomorrow: ${tomorrowContext}.
    
    DECISION MATRIX:
    
    1. IF DELETING MEAL:
       A. Goal: "build_muscle" / "muscle_gain":
          - PRIORITY: "spread_today" -> Distribute nutrient/cal load to another meal. Target one of: [${availableMeals.join(', ')}].
          - PRIORITY: "bank_credit" -> Save as credit.
          - ALERT: "reschedule" -> Move to tomorrow if protein intake is critical.
       
       B. Goal: "lose_weight":
          - PRIORITY: "spread_today" -> Add calories to future meal/snack (Target: [${availableMeals.join(', ')}]) to prevent large deficit.
          - PRIORITY: "plug" -> Suggest ADDING A NEW small snack (e.g. "Apple", "Yogurt") if crash risk.
          - PRIORITY: "bank_credit" -> Save credit.
    
    2. IF DELETING WORKOUT:
       - PRIORITY: "reschedule" -> Move to next day.
       - PRIORITY: "bank_debt" -> Log as missed volume (pay back later).
    
    OUTPUT JSON (DeletionAnalysis):
    {
      "isSafe": boolean,
      "impactLevel": "low" | "medium" | "high",
      "warning": "Explanation in ${lang}",
      "remedies": [
        {
          "id": "unique_id",
          "type": "spread_today" | "downshift" | "bank_debt" | "bank_credit" | "reschedule" | "plug" | "none",
          "title": "Short title in ${lang}",
          "description": "Explanation in ${lang}",
          "actionLabel": "Button Label",
          "data": {
            // targetMeal MUST be one of: [${availableMeals.join(', ')}] if possible.
            // spread_today: { "targetMeal": "string", "amount": number } (Use this to INCREASE existing meal/snack)
            // downshift: { "targetMeal": "string", "reduction": number }
            // plug: { "replacement": "string", "calories": number } (Use this to ADD NEW snack)
            // bank_credit: { "amount": number, "description": "string" }
            // bank_debt: { "volume": number, "description": "string" }
          }
        }
      ]
    }
    
    Return 2-4 remedies. Language: ${lang}.
    `;

    try {
      const { data: result } = await ai.generateStructuredOutput({
        prompt,
        taskType: 'guardian_analysis',
      });

      if (!Array.isArray(result.remedies)) result.remedies = [];
      if (result.remedies.length === 0) {
        result.remedies = [{ id: 'fs_del', type: 'none', title: 'Proceed', description: 'Delete item.', actionLabel: 'Delete' }];
      }
      if (!result.isSafe) result.isSafe = true;
      if (!result.impactLevel) result.impactLevel = 'low';
      if (!result.warning) result.warning = 'Confirm deletion?';

      // Log action
      await pool.query(
        `INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload) VALUES($1,$2,$3,$4,$5)`,
        [user.userId, 'analysis', type, title, JSON.stringify({ calories, result })]
      ).catch(e => req.log.error({ error: e, requestId: req.id }, 'Failed to log guardian action'));

      return reply.send(result);
    } catch (e: unknown) {
      req.log.error({ error: "Guardian analysis failed", e, requestId: req.id });

      return reply.send({
        isSafe: true,
        impactLevel: 'low',
        warning: lang === 'tr'
          ? `"${title}" silinsin mi? (${calories} kcal)`
          : `Delete "${title}"? (${calories} kcal)`,
        remedies: [{
          id: 'err_del',
          type: 'delete_extra',
          title: lang === 'tr' ? 'Sil' : 'Delete',
          description: lang === 'tr' ? 'Bu öğeyi planından kaldır.' : 'Remove this item from your plan.',
          actionLabel: lang === 'tr' ? 'Sil' : 'Delete'
        }]
      });
    }
  });

  // Apply deletion remedy
  app.post('/guardian/apply-remedy', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({
      remedy: z.any(), // TODO: define RemedyAction schema
      item: z.any(), // TODO: define PlanItem schema
      date: z.string(),
      remainingMeals: z.array(z.unknown()).default([])
    }).parse(req.body);

    const { remedy, item, date, remainingMeals } = body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
        [user.userId]
      );
      if (rows.length === 0) throw new Error('Profile not found');

      const profileData = rows[0].profile_data || {};
      const skippedItems = profileData.skippedItems || [];
      const dailyMealModifications = profileData.dailyMealModifications || {}; // Expect Record<Date, Array<ModObject>>

      // 1. Mark item as skipped
      const newSkipped = [...skippedItems, { id: item.id, date }];

      // 2. Apply Remedy
      const newMods = { ...dailyMealModifications };
      if (!newMods[date]) newMods[date] = []; // Initialize as array, or ensure it is array if exists
      if (!Array.isArray(newMods[date])) {
        // Migration fix: If previously it was an object, wipe it or wrap it (wipe safer to avoid type errors)
        newMods[date] = [];
      }

      if (remedy.type === 'spread_today' || remedy.type === 'downshift') {
        const targetName = remedy.data?.targetMeal || 'Dinner';
        const calories = remedy.type === 'spread_today' ? (remedy.data?.amount || 0) : -(remedy.data?.reduction || 0);

        // Find actual Meal ID from Plan
        const mealId = findMealIdOrName(profileData, date, targetName);

        if (mealId) {
          newMods[date].push({
            mealId: mealId,
            calories: calories,
            note: `Guardian: ${remedy.title}`
          });
          req.log.info(`[Guardian] Applied ${remedy.type} to ${mealId}: ${calories} cal`);
        } else {
          req.log.warn(`[Guardian] Could not find meal ID for name '${targetName}'.`);
        }

      } else if (remedy.type === 'plug') {
        const replacement = remedy.data?.replacement || 'Snack';
        const cal = remedy.data?.calories || 100;

        // Try to find a snack slot
        const snackId = findMealIdOrName(profileData, date, 'snack');
        if (snackId) {
          newMods[date].push({
            mealId: snackId,
            calories: cal,
            note: `Guardian Plug: ${replacement}`
          });
        }
      } else if (remedy.type === 'reschedule') {
        const targetDate = remedy.data?.targetDate || new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0];
        const lastSkip = newSkipped[newSkipped.length - 1];
        if (lastSkip) {
          lastSkip.rescheduleTo = targetDate;
          lastSkip.rescheduled = true;
        }

        // Add to rescheduledItems if it's a workout
        if (item.type === 'training_block' || item.type === 'training') {
          const rescheduledItems = profileData.rescheduledItems || [];

          // Find workout details from training program
          const trainingProgram = profileData.currentTrainingProgram;
          let workoutData: any = null;
          const today = new Date(date);
          const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' });

          if (trainingProgram && trainingProgram.schedule && item.data) {
            // Use the exercise data from the item
            workoutData = {
              day: dayOfWeek,
              focus: item.data.focus || 'Full Body',
              exercises: item.data.exercises || [item.data],
              analysis: item.data.analysis || trainingProgram.analysis
            };
          } else if (item.data) {
            // Fallback: use item data directly
            workoutData = {
              day: dayOfWeek,
              focus: 'Full Body',
              exercises: Array.isArray(item.data) ? item.data : [item.data],
              name: item.title
            };
          } else {
            // Basic structure
            workoutData = {
              day: dayOfWeek,
              focus: 'Full Body',
              exercises: [],
              name: item.title || 'Rescheduled Workout'
            };
          }

          rescheduledItems.push({
            id: `rescheduled_workout_${Date.now()}`,
            type: 'workout',
            targetDate: targetDate,
            title: item.title || `Rescheduled ${dayOfWeek} Workout`,
            data: workoutData,
            originalDate: date,
            reason: 'Guardian reschedule recommendation'
          });

          profileData.rescheduledItems = rescheduledItems;
        }
      } else if (remedy.type === 'bank_credit') {
        const amount = remedy.data?.amount || item.data?.recipe?.calories || item.data?.estimatedCalories || 0;
        await client.query(`INSERT INTO calorie_transactions(user_id, type, amount, description, impact) VALUES($1,$2,$3,$4,$5)`,
          [user.userId, 'deposit', amount, remedy.data?.description || 'Saved calories', JSON.stringify({ source: 'guardian', itemId: item.id })]);
      } else if (remedy.type === 'bank_debt') {
        const volume = remedy.data?.volume || item.data?.recipe?.calories || item.data?.estimatedCalories || 0;
        await client.query(`INSERT INTO calorie_transactions(user_id, type, amount, description, impact) VALUES($1,$2,$3,$4,$5)`,
          [user.userId, 'withdrawal', -volume, remedy.data?.description || 'Missed workout', JSON.stringify({ source: 'guardian', itemId: item.id })]);
      }

      await client.query(
        `UPDATE user_profiles SET profile_data = $1::jsonb, updated_at = now() WHERE user_id = $2`,
        [JSON.stringify({
          ...profileData,
          skippedItems: newSkipped,
          dailyMealModifications: newMods,
          rescheduledItems: profileData.rescheduledItems || []
        }), user.userId]
      );

      await client.query(`INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload) VALUES($1,$2,$3,$4,$5)`,
        [user.userId, 'remedy', item.type || 'unknown', item.title || 'Item', JSON.stringify({ remedy, success: true })]);

      await client.query('COMMIT');
      return reply.send({ success: true, skippedItems: newSkipped, modifications: newMods });

    } catch (e: unknown) {
      await client.query('ROLLBACK');
      const error = e as Error;
      req.log.error({ error: "Apply remedy failed", e, requestId: req.id });
      return reply.status(500).send({ error: error.message });
    } finally {
      client.release();
    }
  });

  // Analyze surplus
  app.post('/guardian/analyze-surplus', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    const body = z.object({
      surplus: z.number(),
      profile: z.any(),
      nextMealName: z.string().optional(),
      nextMealCalories: z.number().optional(),
      lang: z.string().default('en')
    }).parse(req.body);

    const { surplus, profile, lang, nextMealName, nextMealCalories } = body;
    const prompt = `ACT AS GUARDIAN AI. User has ${surplus}kcal surplus. Goal: ${profile.primaryGoal}.
    Next Meal Context: ${nextMealName ? `${nextMealName} (~${nextMealCalories} cal)` : "Unknown"}.
    Generate 4 strategies (athlete, chef, hybrid, banker). Return JSON { strategies: { athlete: {...}, ... } }. Language: ${lang}.`;

    try {
      const { data: result } = await ai.generateStructuredOutput({
        prompt,
        taskType: 'guardian_analysis',
      });

      if (!result.strategies) {
        result.strategies = {
          athlete: { title: 'The Athlete', description: 'Burn it off', explanation: 'Generate workout', data: {} },
          chef: { title: 'The Chef', description: 'Adjust meal', explanation: 'Reduce next meal', data: {} },
          hybrid: { title: 'The Hybrid', description: 'Balance both', explanation: 'Small workout + meal reduction', data: {} },
          banker: { title: 'The Banker', description: 'Defer to tomorrow', explanation: 'Add to calorie bank', data: {} }
        };
      }
      return reply.send(result);
    } catch (e) {
      return reply.send({ strategies: { athlete: { title: 'Athlete', description: 'Burn it', data: { estimatedBurn: surplus } } } });
    }
  });

  // Analyze extra training
  app.post('/guardian/analyze-extra-training', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({
      exerciseName: z.string(),
      durationMinutes: z.number().optional(),
      muscleGroups: z.array(z.string()).optional(),
      profile: z.any(),
      lang: z.string().default('en'),
      todaysPlan: z.array(z.unknown()).optional()
    }).parse(req.body);
    const { exerciseName, durationMinutes, muscleGroups = [], profile, lang, todaysPlan = [] } = body;
    const prompt = `GUARDIAN AI - EXTRA TRAINING REVIEW. New: ${exerciseName}. Muscles: ${muscleGroups.join(',')}. Plan: ${todaysPlan.map((p: any) => p?.title).join(',')}. Profile: ${profile.primaryGoal}. Detect overload. Return JSON { warning, suggestions }.`;

    try {
      const { data: parsed } = await ai.generateStructuredOutput({
        prompt,
        taskType: 'guardian_analysis',
      });
      return reply.send({ warning: parsed.warning || '', suggestions: parsed.suggestions?.slice(0, 3) || [] });
    } catch (e: unknown) {
      return reply.send({ warning: "Consider recovery.", suggestions: [] });
    }
  });

  // Analyze meal replacement
  app.post('/guardian/analyze-meal-replacement', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = z.object({
      loggedFood: z.any(),
      profile: z.any(),
      nearbyMeals: z.array(z.any()).default([]),
      lang: z.string().default('en')
    }).parse(req.body);
    const { loggedFood, nearbyMeals } = body;
    if (nearbyMeals.length === 0) return reply.send({ shouldReplace: false });

    const prompt = `GUARDIAN AI. User logged ${loggedFood.name}. Nearby: ${nearbyMeals[0].name}. Should replace? JSON { shouldReplace, suggestion }.`;

    try {
      const { data } = await ai.generateStructuredOutput({
        prompt,
        taskType: 'guardian_analysis',
      });
      return reply.send(data);
    } catch (e: unknown) {
      return reply.send({ shouldReplace: false });
    }
  });

  app.get('/guardian/actions', { preHandler: authGuard }, async (req) => {
    const user = (req as AuthenticatedRequest).user;
    const { rows } = await pool.query(`SELECT id, action_type, item_type, item_title, payload, created_at FROM guardian_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.userId]);
    return rows.map((r: any) => ({ id: r.id, actionType: r.action_type, itemType: r.item_type, itemTitle: r.item_title, payload: r.payload, createdAt: r.created_at }));
  });

  // Analyze late wake-up (15:00+) and provide remedies for missed meals/workouts
  app.post('/guardian/analyze-late-wake', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    const body = z.object({
      wakeTime: z.string(),
      missedItems: z.array(z.object({
        type: z.enum(['meal', 'training']),
        name: z.string(),
        calories: z.number().optional(),
        scheduledTime: z.string()
      })),
      profile: z.any(), // TODO: define UserProfile schema
      availableSlots: z.array(z.object({
        start: z.string(),
        end: z.string()
      })).default([]),
      lang: z.string().default('en'),
      userPreferences: z.object({
        wantsWorkout: z.boolean().optional(),
        desiredMeals: z.number().min(1).max(5).optional()
      }).optional()
    }).parse(req.body);

    const { wakeTime, missedItems, profile, availableSlots, lang, userPreferences } = body;

    const missedMeals = missedItems.filter(i => i.type === 'meal');
    const missedWorkouts = missedItems.filter(i => i.type === 'training');

    const prompt = `
    ACT AS GUARDIAN AI - LATE WAKE-UP RECOVERY PLANNER.
    
    User woke up at ${wakeTime}, which is very late (15:00+).
    They missed the following items:
    
    MISSED MEALS:
    ${missedMeals.map(m => `- ${m.name} (${m.calories || 'unknown'} cal) @ ${m.scheduledTime}`).join('\n') || 'None'}
    
    MISSED WORKOUTS:
    ${missedWorkouts.map(w => `- ${w.name} (${w.calories || 'unknown'} cal) @ ${w.scheduledTime}`).join('\n') || 'None'}
    
    USER PROFILE:
    - Primary Goal: ${profile.primaryGoal || 'maintain'}
    - Fitness Level: ${profile.fitnessLevel || 'intermediate'}
    - Available Time Slots: ${availableSlots.map(s => `${s.start}-${s.end}`).join(', ') || 'Rest of day'}
    
    ${userPreferences ? `
    USER PREFERENCES (IMPORTANT):
    - Wants to workout today: ${userPreferences.wantsWorkout !== undefined ? (userPreferences.wantsWorkout ? 'YES' : 'NO - Reschedule') : 'Not specified'}
    - Desired meals today: ${userPreferences.desiredMeals || 'Not specified'}
    
    CRITICAL: Respect user preferences when generating recommendations!
    - If user wants to workout: DO NOT suggest rescheduling, suggest shorter/modified workouts
    - If user does NOT want to workout: Prioritize rescheduling to tomorrow
    - If user wants fewer meals: Strongly prioritize consolidation strategies
    ` : ''}
    
    YOUR TASK:
    1. Analyze biological impact of missing these items
    2. Prioritize what's most critical to address TODAY
    3. Suggest practical remedies considering the late wake-up
    
    REMEDY STRATEGIES:
    - For meals: Combine/consolidate into remaining meals, suggest quick nutrient-dense options
    - For workouts: Suggest shorter versions, reschedule to tomorrow, or mark as recovery day
    - Consider energy levels after late wake-up
    - Avoid overwhelming the user with too many changes
    
    OUTPUT JSON:
    {
      "severity": "low" | "medium" | "high",
      "message": "Brief explanation in ${lang}",
      "recommendations": [
        {
          "id": "rec_1",
          "priority": "high" | "medium" | "low",
          "type": "consolidate_meals" | "reschedule_workout" | "recovery_day" | "quick_meal" | "skip_item",
          "title": "Title in ${lang}",
          "description": "Detailed explanation in ${lang}",
          "actionLabel": "Button text in ${lang}",
          "affectedItems": ["item names"],
          "data": {
            // consolidate_meals: { targetMeal: string, addedCalories: number, items: string[] }
            // reschedule_workout: { workoutName: string, suggestedDate: "tomorrow" | "next_rest_day", reason: string }
            // recovery_day: { reason: string, restActivities: string[] }
            // quick_meal: { mealName: string, calories: number, ingredients: string[], prepTime: string }
            // skip_item: { itemName: string, reason: string, compensation: string }
          }
        }
      ],
      "dailyAdjustments": {
        "totalMissedCalories": number,
        "redistributionPlan": "Brief plan in ${lang}",
        "energyConsiderations": "Brief note in ${lang}"
      }
    }
    
    Return 2-5 actionable recommendations. Language: ${lang}.
    Be practical and empathetic - late wake-ups happen!
    `;

    try {
      const { data: result } = await ai.generateStructuredOutput({
        prompt,
        taskType: 'guardian_analysis',
      });

      // Validate and set defaults
      if (!result.severity) result.severity = 'medium';
      if (!result.message) result.message = 'You woke up late. Let\'s adjust your day.';
      if (!Array.isArray(result.recommendations)) result.recommendations = [];
      if (!result.dailyAdjustments) {
        result.dailyAdjustments = {
          totalMissedCalories: missedMeals.reduce((sum, m) => sum + (m.calories || 0), 0),
          redistributionPlan: 'Consolidate meals into remaining time slots',
          energyConsiderations: 'Take it easy today'
        };
      }

      // Log action
      await pool.query(
        `INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload) VALUES($1,$2,$3,$4,$5)`,
        [user.userId, 'analysis', 'late_wake', `Wake at ${wakeTime}`, JSON.stringify({ missedItems, result })]
      ).catch(e => req.log.error({ error: e, requestId: req.id }, 'Failed to log late wake guardian action'));

      return reply.send(result);
    } catch (e: unknown) {
      req.log.error({ error: "Guardian late wake analysis failed", e, requestId: req.id });

      // Fallback response
      return reply.send({
        severity: 'medium',
        message: 'You woke up late. Here are some suggestions to adjust your day.',
        recommendations: [
          {
            id: 'fb_consolidate',
            priority: 'high',
            type: 'consolidate_meals',
            title: 'Consolidate Meals',
            description: 'Combine missed meals into your remaining meals today',
            actionLabel: 'Apply',
            affectedItems: missedMeals.map(m => m.name),
            data: {
              targetMeal: 'Dinner',
              addedCalories: missedMeals.reduce((sum, m) => sum + (m.calories || 0), 0),
              items: missedMeals.map(m => m.name)
            }
          },
          {
            id: 'fb_skip_workout',
            priority: 'medium',
            type: 'reschedule_workout',
            title: 'Reschedule Workouts',
            description: 'Move missed workouts to tomorrow for better recovery',
            actionLabel: 'Reschedule',
            affectedItems: missedWorkouts.map(w => w.name),
            data: {
              workoutName: missedWorkouts[0]?.name || 'Workout',
              suggestedDate: 'tomorrow',
              reason: 'Late wake-up needs recovery time'
            }
          }
        ],
        dailyAdjustments: {
          totalMissedCalories: missedMeals.reduce((sum, m) => sum + (m.calories || 0), 0),
          redistributionPlan: 'Consolidate into remaining meals',
          energyConsiderations: 'Focus on nutrient-dense foods'
        }
      });
    }
  });

  // Apply late wake recommendation
  app.post('/guardian/apply-late-wake-recommendation', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;

    const body = z.object({
      recommendation: z.object({
        id: z.string(),
        type: z.enum(['consolidate_meals', 'reschedule_workout', 'recovery_day', 'quick_meal', 'skip_item']),
        data: z.any() // TODO: define recommendation data per type
      }),
      date: z.string(),
      wakeTime: z.string()
    }).parse(req.body);

    const { recommendation, date, wakeTime } = body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
        [user.userId]
      );
      if (rows.length === 0) throw new Error('Profile not found');

      const profileData = rows[0].profile_data || {};
      const timelineOverrides = profileData.timelineOverrides || {};
      const dailyMealModifications = profileData.dailyMealModifications || {};
      const skippedItems = profileData.skippedItems || [];

      let appliedChanges: any = {};

      switch (recommendation.type) {
        case 'consolidate_meals':
          // Add calories to target meal
          if (recommendation.data?.targetMeal && recommendation.data?.addedCalories) {
            const targetMealName = recommendation.data.targetMeal;
            const addedCals = recommendation.data.addedCalories;

            // Find meal ID from plan
            const mealId = findMealIdOrName(profileData, date, targetMealName);

            if (!dailyMealModifications[date]) dailyMealModifications[date] = [];
            if (!Array.isArray(dailyMealModifications[date])) dailyMealModifications[date] = [];

            if (mealId) {
              dailyMealModifications[date].push({
                mealId: mealId,
                calories: addedCals,
                note: `Late Wake: Consolidated from missed meals`
              });
              appliedChanges.consolidatedCalories = addedCals;
              appliedChanges.targetMeal = targetMealName;
            }

            // Mark missed items as skipped
            if (recommendation.data?.items && Array.isArray(recommendation.data.items)) {
              recommendation.data.items.forEach((itemName: string) => {
                skippedItems.push({
                  id: `late_wake_${itemName}_${Date.now()}`,
                  date: date,
                  reason: 'late_wake_consolidation'
                });
              });
            }
          }
          break;

        case 'reschedule_workout':
          // Mark workout as skipped and add to rescheduledItems for tomorrow
          if (recommendation.data?.workoutName) {
            const workoutName = recommendation.data.workoutName;
            const tomorrowDate = recommendation.data.suggestedDate === 'tomorrow'
              ? new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0]
              : recommendation.data.suggestedDate || new Date(new Date(date).getTime() + 86400000).toISOString().split('T')[0];

            // Mark as skipped today
            skippedItems.push({
              id: `late_wake_workout_${Date.now()}`,
              date: date,
              rescheduleTo: tomorrowDate,
              rescheduled: true,
              reason: recommendation.data.reason || 'Late wake-up'
            });

            // Add to rescheduledItems for tomorrow
            const rescheduledItems = profileData.rescheduledItems || [];

            // Find workout details from training program
            const trainingProgram = profileData.currentTrainingProgram;
            let workoutData: any = null;
            const today = new Date(date);
            const dayOfWeek = today.toLocaleDateString('en-US', { weekday: 'long' });

            if (trainingProgram && trainingProgram.schedule) {
              // Find the workout in today's schedule
              const todaySchedule = trainingProgram.schedule.find((day: any) =>
                day.day === dayOfWeek || day.day.toLowerCase().includes(dayOfWeek.toLowerCase())
              );

              if (todaySchedule && todaySchedule.exercises) {
                workoutData = {
                  day: todaySchedule.day,
                  focus: todaySchedule.focus,
                  exercises: todaySchedule.exercises,
                  analysis: todaySchedule.analysis || trainingProgram.analysis
                };
              }
            }

            // If workout data not found, create a basic structure
            if (!workoutData) {
              workoutData = {
                day: dayOfWeek,
                focus: 'Full Body',
                exercises: [],
                name: workoutName
              };
            }

            rescheduledItems.push({
              id: `rescheduled_workout_${Date.now()}`,
              type: 'workout',
              targetDate: tomorrowDate,
              title: workoutName || `Rescheduled ${dayOfWeek} Workout`,
              data: workoutData,
              originalDate: date,
              reason: recommendation.data.reason || 'Late wake-up reschedule'
            });

            appliedChanges.rescheduledWorkout = workoutName;
            appliedChanges.rescheduledTo = tomorrowDate;

            // Update profileData with rescheduledItems
            profileData.rescheduledItems = rescheduledItems;
          }
          break;

        case 'recovery_day':
          // Mark all workouts as skipped with recovery note
          if (recommendation.data?.restActivities) {
            appliedChanges.recoveryActivities = recommendation.data.restActivities;
          }
          break;

        case 'quick_meal':
          // Add quick meal suggestion to modifications
          if (recommendation.data?.mealName && recommendation.data?.calories) {
            // This could be logged as an extra meal or added to timeline
            appliedChanges.quickMealSuggestion = recommendation.data.mealName;
            appliedChanges.quickMealCalories = recommendation.data.calories;
          }
          break;

        case 'skip_item':
          // Simply skip the item with compensation note
          if (recommendation.data?.itemName) {
            skippedItems.push({
              id: `late_wake_skip_${Date.now()}`,
              date: date,
              reason: recommendation.data.compensation || 'Late wake-up'
            });
            appliedChanges.skippedItem = recommendation.data.itemName;
          }
          break;
      }

      // Update profile with modifications
      await client.query(
        `UPDATE user_profiles 
         SET profile_data = $1::jsonb, updated_at = now() 
         WHERE user_id = $2`,
        [JSON.stringify({
          ...profileData,
          timelineOverrides,
          dailyMealModifications,
          skippedItems,
          rescheduledItems: profileData.rescheduledItems || []
        }), user.userId]
      );

      // Log the action
      await client.query(
        `INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload) 
         VALUES($1,$2,$3,$4,$5)`,
        [
          user.userId,
          'remedy',
          'late_wake_recommendation',
          recommendation.type,
          JSON.stringify({ recommendation, appliedChanges, date, wakeTime })
        ]
      );

      await client.query('COMMIT');

      return reply.send({
        success: true,
        appliedChanges,
        message: 'Recommendation applied successfully'
      });

    } catch (e: unknown) {
      await client.query('ROLLBACK');
      const error = e as Error;
      req.log.error({ error: "Apply late wake recommendation failed", e, requestId: req.id });
      return reply.status(500).send({ error: error.message });
    } finally {
      client.release();
    }
  });
}
