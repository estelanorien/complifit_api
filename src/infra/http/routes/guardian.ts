import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth';
import { pool } from '../../db/pool';
import fetch from 'node-fetch';
import { env } from '../../../config/env';

const cleanGeminiJson = (text: string): string => {
  if (!text) return text;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
};

export async function guardianRoutes(app: FastifyInstance) {
  // Analyze deletion impact via Gemini
  app.post('/guardian/analyze-deletion', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      type: z.enum(['training', 'meal']),
      title: z.string(),
      calories: z.number(),
      profile: z.any(),
      remainingItems: z.number(),
      lang: z.string().default('en'),
      recentLogs: z.array(z.string()).default([]),
      tomorrowContext: z.string().default('Normal day'),
      currentNetState: z.number().optional()
    }).parse(req.body);

    const { type, title, calories, profile, remainingItems, lang, recentLogs, tomorrowContext, currentNetState } = body;

    const isDeficit = currentNetState && currentNetState < 0;
    const isSurplus = currentNetState && currentNetState > 0;

    const prompt = `
    ACT AS GUARDIAN AI - A BIOLOGICAL SAFETY NET.
    User wants to delete ${type}: "${title}" (${calories} cal).
    
    LIVE CONTEXT:
    - Primary Goal: ${profile.primaryGoal || 'maintain'}.
    - Specific Goals: ${profile.specificGoals?.join(', ') || 'None'}.
    - Conditions: ${profile.conditions?.join(', ') || 'None'}.
    - Fitness Level: ${profile.fitnessLevel || 'intermediate'}.
    - Net State: ${currentNetState ? (isDeficit ? 'Deficit' : 'Surplus') + ' ' + Math.abs(currentNetState) + 'kcal' : 'Balanced'}.
    - Remaining items today: ${remainingItems}.
    - Recent Logs: ${recentLogs.join(', ') || "None"}.
    - Tomorrow: ${tomorrowContext}.
    
    DECISION MATRIX - PROFILE-BASED REMEDY SELECTION:
    
    1. IF DELETING MEAL:
       A. Goal: "build_muscle" OR "muscle_gain" OR "recomposition":
          - HIGH PRIORITY: "spread_today" - Distribute protein/carbs to remaining meals (targetMeal: "dinner", amount: ${Math.floor(calories * 0.7)})
          - MEDIUM PRIORITY: "plug" - Replace with high-protein snack (replacement: "Protein Shake", calories: ${Math.floor(calories * 0.4)})
          - MEDIUM PRIORITY: "bank_credit" - Save calories to Calorie Bank as credit for later use (amount: ${calories}, description: "Saved from ${title}")
          - LOW PRIORITY: "reschedule" - Move meal to tomorrow if volume is critical
          - Logic: Don't lose the protein/nutrients needed for hypertrophy.
       
       B. Goal: "lose_weight" OR "fat_loss":
          - If already in deficit (${isDeficit ? 'YES' : 'NO'}): WARN HIGH IMPACT
          - HIGH PRIORITY: "plug" - Small essential snack to prevent blood sugar crash (replacement: "Protein Bar", calories: ${Math.floor(calories * 0.3)})
          - MEDIUM PRIORITY: "downshift" - Reduce next meal carbs to maintain deficit (reduction: ${Math.floor(calories * 0.4)}, targetMeal: "dinner")
          - MEDIUM PRIORITY: "bank_credit" - Save calories to Calorie Bank as credit (amount: ${calories}, description: "Saved from ${title}")
          - Logic: Prevent metabolic slowdown while maintaining deficit.
       
       C. Condition: "diabetes" OR "blood_sugar":
          - CRITICAL: "plug" - Essential snack to stabilize (replacement: "Balanced Snack", calories: ${Math.floor(calories * 0.5)})
          - Logic: Prevent blood sugar crash.
    
    2. IF DELETING WORKOUT/TRAINING:
       A. Goal: "build_muscle" OR "performance":
          - HIGH PRIORITY: "reschedule" - Move to tomorrow or next available day (targetDate: calculate next workout day)
          - MEDIUM PRIORITY: "bank_debt" - Track missed volume (volume: ${calories}, description: "Missed ${title}")
          - Logic: Volume is critical for growth/performance.
       
       B. Goal: "lose_weight" OR "fat_loss":
          - HIGH PRIORITY: "downshift" - Lower next meal carbs to match reduced burn (reduction: ${Math.floor(calories * 0.5)}, targetMeal: "dinner")
          - MEDIUM PRIORITY: "bank_debt" - Track as caloric debt (volume: ${calories})
          - Logic: Maintain caloric deficit.
       
       C. Fitness Level: "beginner":
          - HIGH PRIORITY: "reschedule" - Move to tomorrow (easier to maintain consistency)
          - Logic: Consistency over intensity for beginners.
    
    3. ALWAYS AVAILABLE:
       - "bank_credit" - Save to Calorie Bank as credit (for meals) or "bank_debt" (for workouts) - Store in Calorie Bank for later use
       - "none" (Delete Anyway) - Nuclear option, accept negative impact. Mark as "Not Recommended" if impact is high.
    
    OUTPUT JSON (DeletionAnalysis Schema):
    {
      "isSafe": boolean (false if high impact and no good remedy),
      "impactLevel": "low" | "medium" | "high",
      "warning": "Clear warning message explaining biological impact in ${lang}",
      "remedies": [
        {
          "id": "unique_id",
          "type": "spread_today" | "downshift" | "bank_debt" | "bank_credit" | "reschedule" | "plug" | "none",
          "title": "User-friendly title in ${lang}",
          "description": "Detailed explanation in ${lang}",
          "actionLabel": "Button label in ${lang}",
          "data": {
            // For spread_today: { "targetMeal": "dinner", "amount": number }
            // For downshift: { "reduction": number, "targetMeal": "dinner" }
            // For bank_debt: { "volume": number, "description": "string" }
            // For bank_credit: { "amount": number, "description": "string" }
            // For reschedule: { "targetDate": "YYYY-MM-DD" }
            // For plug: { "replacement": "string", "calories": number }
          }
        }
      ]
    }
    
    Return 2-4 remedies ordered by priority. Always include "none" as last option.
    Language: ${lang}.
    `;

    const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

    try {
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

      const result = JSON.parse(cleanGeminiJson(text) || '{}');

      // Ensure remedies is an array
      if (!Array.isArray(result.remedies)) {
        result.remedies = [];
      }

      // Fallback if no remedies
      if (result.remedies.length === 0) {
        result.remedies = [{
          id: 'fs_delete',
          type: 'none',
          title: 'Proceed',
          description: 'Delete without changes.',
          actionLabel: 'Delete'
        }];
      }

      // Ensure required fields
      if (!result.isSafe) result.isSafe = true;
      if (!result.impactLevel) result.impactLevel = 'low';
      if (!result.warning) result.warning = 'Confirm deletion?';

      await pool.query(
        `INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload)
         VALUES($1,$2,$3,$4,$5)`,
        [
          user.userId,
          'analysis',
          type,
          title,
          JSON.stringify({
            calories,
            result,
            context: { remainingItems, currentNetState, tomorrowContext }
          })
        ]
      ).catch((e: any) => console.error("Guardian analysis log failed", e));

      return reply.send(result);
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      console.error("Guardian analyze failed", e);
      // Return safe fallback
      return reply.send({
        isSafe: true,
        impactLevel: 'low' as const,
        warning: "Confirm deletion?",
        remedies: [{ id: 'err_del', type: 'none' as const, title: 'Delete', description: '', actionLabel: 'Delete' }]
      });
    }
  });

  // Apply deletion remedy (update profile with skipped items and modifications)
  app.post('/guardian/apply-remedy', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;

    const body = z.object({
      remedy: z.any(),
      item: z.any(),
      date: z.string(),
      remainingMeals: z.array(z.any()).default([])
    }).parse(req.body);

    const { remedy, item, date, remainingMeals } = body;

    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000'); // 30 seconds timeout
      await client.query('BEGIN');
      
      // Get current profile with FOR UPDATE lock
      const { rows } = await client.query(
        `SELECT profile_data FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
        [user.userId]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'Profile not found' });
      }

      const profileData = rows[0].profile_data || {};
      const skippedItems = profileData.skippedItems || [];
      const dailyMealModifications = profileData.dailyMealModifications || {};

      // 1. Mark item as skipped
      const newSkipped = [...skippedItems, { id: item.id, date }];

      // 2. Apply Remedy Logic
      let newMods = { ...dailyMealModifications };

      if (remedy.type === 'spread_today') {
        // Distribute calories to remaining meals
        const targetMeal = remedy.data?.targetMeal || 'dinner';
        const amount = remedy.data?.amount || 0;
        const dateKey = date;
        if (!newMods[dateKey]) newMods[dateKey] = {};
        if (!newMods[dateKey][targetMeal]) newMods[dateKey][targetMeal] = { calories: 0 };
        const previousCalories = newMods[dateKey][targetMeal].calories || 0;
        newMods[dateKey][targetMeal].calories = previousCalories + amount;
        console.log(`[Guardian] spread_today: Adding ${amount} cal to ${targetMeal} on ${dateKey}. Total: ${newMods[dateKey][targetMeal].calories}`);
      } else if (remedy.type === 'plug') {
        // Add a replacement snack
        const replacement = remedy.data?.replacement || 'Snack';
        const replacementCalories = remedy.data?.calories || 150;
        const dateKey = date;
        if (!newMods[dateKey]) newMods[dateKey] = {};
        if (!newMods[dateKey].extraMeals) newMods[dateKey].extraMeals = [];
        newMods[dateKey].extraMeals.push({
          name: replacement,
          calories: replacementCalories,
          type: 'snack',
          reason: 'guardian_plug'
        });
      } else if (remedy.type === 'downshift') {
        // Lower next meal carbs
        const reduction = remedy.data?.reduction || 0;
        const targetMeal = remedy.data?.targetMeal || 'dinner';
        const dateKey = date;
        if (!newMods[dateKey]) newMods[dateKey] = {};
        if (!newMods[dateKey][targetMeal]) newMods[dateKey][targetMeal] = { carbs: 0 };
        newMods[dateKey][targetMeal].carbs = (newMods[dateKey][targetMeal].carbs || 0) - reduction;
      } else if (remedy.type === 'reschedule') {
        // Mark for rescheduling (stored in skippedItems with reschedule flag)
        const rescheduleDate = remedy.data?.targetDate || date;
        // Update skipped item with reschedule info
        const skippedItem = newSkipped[newSkipped.length - 1];
        if (skippedItem) {
          skippedItem.rescheduleTo = rescheduleDate;
          skippedItem.rescheduled = true;
        }
        console.log(`[Guardian] reschedule: Moving item to ${rescheduleDate}`);
      } else if (remedy.type === 'bank_credit') {
        // Save calories to Calorie Bank as credit (for deleted meals)
        const creditAmount = remedy.data?.amount || item.data?.recipe?.calories || item.data?.estimatedCalories || 0;
        const description = remedy.data?.description || `Saved from ${item.title || item.name}`;

        // Add to calorie bank as credit
        await client.query(
          `INSERT INTO calorie_transactions(user_id, type, amount, description, impact)
           VALUES($1, $2, $3, $4, $5)`,
          [
            user.userId,
            'deposit',
            creditAmount, // Positive for credit
            description,
            JSON.stringify({ source: 'guardian_bank_credit', itemId: item.id, date })
          ]
        );

        console.log(`[Guardian] bank_credit: Saved ${creditAmount} as credit`);
      } else if (remedy.type === 'bank_debt') {
        // Track missed volume/calories as debt
        const itemCalories = item.data?.recipe?.calories || item.data?.estimatedCalories || 0;
        const missedVolume = remedy.data?.volume || itemCalories || 0;
        const description = remedy.data?.description || `Missed ${item.title || item.name}`;

        // Add to calorie bank as debt
        await client.query(
          `INSERT INTO calorie_transactions(user_id, type, amount, description, impact)
           VALUES($1, $2, $3, $4, $5)`,
          [
            user.userId,
            'withdrawal',
            -missedVolume, // Negative for debt
            description,
            JSON.stringify({ source: 'guardian_bank_debt', itemId: item.id, date })
          ]
        );

        // Also track in profile metadata
        if (!profileData.debtTracking) profileData.debtTracking = {};
        if (!profileData.debtTracking[date]) profileData.debtTracking[date] = { missedVolume: 0 };
        profileData.debtTracking[date].missedVolume += missedVolume;
        console.log(`[Guardian] bank_debt: Tracked ${missedVolume} as debt`);
      }

      // Update profile - combine all updates in one query
      const updatedProfileData = {
        ...profileData,
        skippedItems: newSkipped,
        dailyMealModifications: newMods,
        ...(profileData.debtTracking ? { debtTracking: profileData.debtTracking } : {})
      };

      await client.query(
        `UPDATE user_profiles
         SET profile_data = $1::jsonb,
             updated_at = now()
         WHERE user_id = $2`,
        [JSON.stringify(updatedProfileData), user.userId]
      );

      await client.query(
        `INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload)
         VALUES($1,$2,$3,$4,$5)`,
        [
          user.userId,
          'remedy',
          item.type || item.data?.type || 'unknown',
          item.title || item.name || 'Unknown Item',
          JSON.stringify({ remedy, item, date, remainingMeals })
        ]
      );

      await client.query('COMMIT');
      console.log(`[Guardian] Final modifications for ${date}:`, JSON.stringify(newMods, null, 2));
      return reply.send({ success: true, skippedItems: newSkipped, modifications: newMods });
    } catch (e: any) {
      await client.query('ROLLBACK');
      const isProduction = process.env.NODE_ENV === 'production';
      console.error("Apply remedy failed", e);
      return reply.status(500).send({ error: isProduction ? 'Remedy application service unavailable' : (e.message || 'Apply remedy failed') });
    } finally {
      client.release();
    }
  });

  // Surplus Mitigation - Generate strategies for surplus calories
  app.post('/guardian/analyze-surplus', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      surplus: z.number(),
      profile: z.any(),
      nextMealName: z.string().optional(),
      nextMealCalories: z.number().optional(),
      lang: z.string().default('en')
    }).parse(req.body);

    const { surplus, profile, nextMealName, nextMealCalories, lang } = body;

    const prompt = `
    ACT AS THE NEGOTIATOR AI - SURPLUS MITIGATION SPECIALIST.
    User is ${surplus} kcal over their daily target.
    
    USER PROFILE:
    - Primary Goal: ${profile.primaryGoal || 'maintain'}.
    - Fitness Level: ${profile.fitnessLevel || 'intermediate'}.
    - Stress Level: ${profile.stressLevel || 'medium'}.
    - Next Meal: ${nextMealName || 'Not specified'} (${nextMealCalories || 0} kcal).
    
    GENERATE 4 MITIGATION STRATEGIES:
    
    1. THE ATHLETE STRATEGY (Burn):
       - Logic: "Eat what you want, but work for it."
       - Action: Generate an Ad-Hoc Workout worth exactly ${surplus} kcal.
       - Best for: fitnessLevel='advanced' OR goal='performance'.
       - Return: { "type": "active_burn", "title": "The Athlete", "description": "...", "explanation": "...", "data": { "workout": {...}, "estimatedBurn": ${surplus} } }
    
    2. THE CHEF STRATEGY (Diet):
       - Logic: "Fix it in the kitchen."
       - Action: Rewrite next meal to save ${surplus} kcal (downsize or ingredient swap).
       - Best for: goal='lose_weight' AND prefers cooking over cardio.
       - Return: { "type": "chef", "title": "The Chef", "description": "...", "explanation": "...", "data": { "targetMeal": "${nextMealName || 'Next Meal'}", "targetReduction": ${surplus} } }
    
    3. THE HYBRID STRATEGY (Balance):
       - Logic: "Meet in the middle."
       - Action: Small workout (${Math.floor(surplus * 0.4)} kcal) + reduce next meal (${Math.floor(surplus * 0.6)} kcal).
       - Best for: fitnessLevel='beginner' OR goal='maintain' (most sustainable).
       - Return: { "type": "hybrid", "title": "The Hybrid", "description": "...", "explanation": "...", "data": { "workout": {...}, "cutAmount": ${Math.floor(surplus * 0.6)} } }
    
    4. THE BANKER STRATEGY (Defer):
       - Logic: "Borrow from tomorrow."
       - Action: Add ${surplus} kcal as negative debt to Calorie Bank. Tomorrow's target reduced automatically.
       - Best for: stressLevel='high' OR user wants to relax today.
       - Return: { "type": "bank_debt", "title": "The Banker", "description": "...", "explanation": "...", "data": { "amount": ${surplus} } }
    
    OUTPUT JSON:
    {
      "strategies": {
        "athlete": { "title": "...", "description": "...", "explanation": "...", "data": {...} },
        "chef": { "title": "...", "description": "...", "explanation": "...", "data": {...} },
        "hybrid": { "title": "...", "description": "...", "explanation": "...", "data": {...} },
        "banker": { "title": "...", "description": "...", "explanation": "...", "data": {...} }
      }
    }
    Language: ${lang}.
    `;

    const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

    try {
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

      const result = JSON.parse(cleanGeminiJson(text) || '{}');

      // Ensure strategies object exists
      if (!result.strategies) {
        result.strategies = {
          athlete: { title: 'The Athlete', description: 'Burn it off', explanation: 'Generate workout', data: {} },
          chef: { title: 'The Chef', description: 'Adjust meal', explanation: 'Reduce next meal', data: {} },
          hybrid: { title: 'The Hybrid', description: 'Balance both', explanation: 'Small workout + meal reduction', data: {} },
          banker: { title: 'The Banker', description: 'Defer to tomorrow', explanation: 'Add to calorie bank', data: {} }
        };
      }

      return reply.send(result);
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      console.error("Surplus analysis failed", e);
      // Return fallback
      return reply.send({
        strategies: {
          athlete: { title: 'The Athlete', description: 'Burn it off', explanation: 'Generate workout', data: { estimatedBurn: surplus } },
          chef: { title: 'The Chef', description: 'Adjust meal', explanation: 'Reduce next meal', data: { targetReduction: surplus } },
          hybrid: { title: 'The Hybrid', description: 'Balance both', explanation: 'Small workout + meal reduction', data: { cutAmount: Math.floor(surplus * 0.6) } },
          banker: { title: 'The Banker', description: 'Defer to tomorrow', explanation: 'Add to calorie bank', data: { amount: surplus } }
        }
      });
    }
  });

  // Analyze extra training (overload/imbalance) via Gemini
  app.post('/guardian/analyze-extra-training', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      exerciseName: z.string(),
      durationMinutes: z.number().optional(),
      muscleGroups: z.array(z.string()).optional(),
      profile: z.any(),
      lang: z.string().default('en'),
      todaysPlan: z.array(z.any()).optional()
    }).parse(req.body);

    const { exerciseName, durationMinutes, muscleGroups = [], profile, lang, todaysPlan = [] } = body;

    const prompt = `
    GUARDIAN AI - EXTRA TRAINING REVIEW
    New extra session: "${exerciseName}" ${durationMinutes ? '(' + durationMinutes + ' min)' : ''}.
    Muscle groups (if detected): ${muscleGroups.join(', ') || 'unknown'}.
    Today's planned training blocks: ${todaysPlan.map((p: any) => p?.title || p?.name || 'block').join(', ') || 'none'}.

    Profile:
    - Goal: ${profile.primaryGoal || 'maintain'}
    - Fitness Level: ${profile.fitnessLevel || 'intermediate'}
    - Conditions: ${profile.conditions?.join(', ') || 'none'}

    Tasks:
    - Detect potential overload or redundant work (same muscle groups back-to-back, too much volume).
    - Suggest concrete adjustments to balance recovery.
    - Keep it concise, 2-3 actionable options max.

    Return JSON:
    {
      "warning": "string",
      "suggestions": [
        { "title": "string", "description": "string", "actionLabel": "string" }
      ]
    }
    Language: ${lang}.
    `;

    const genEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

    try {
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
      const parsed = JSON.parse(cleanGeminiJson(text) || '{}');
      if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
      return reply.send({
        warning: parsed.warning || '',
        suggestions: parsed.suggestions.slice(0, 3)
      });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      console.error("Guardian analyze extra training failed", e);
      return reply.send({
        warning: "Extra session logged. Consider recovery balance.",
        suggestions: [
          { title: "Lighten next similar muscle session", description: "Reduce sets or load for overlapping muscle groups.", actionLabel: "Got it" }
        ]
      });
    }
  });

  app.get('/guardian/actions', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(
      `SELECT id, action_type, item_type, item_title, payload, created_at
       FROM guardian_actions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [user.userId]
    );
    return rows.map((r: any) => ({
      id: r.id,
      actionType: r.action_type,
      itemType: r.item_type,
      itemTitle: r.item_title,
      payload: r.payload,
      createdAt: r.created_at
    }));
  });

  // Analyze meal replacement opportunity
  app.post('/guardian/analyze-meal-replacement', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });

    const body = z.object({
      loggedFood: z.object({
        name: z.string(),
        calories: z.number(),
        timestamp: z.string(), // ISO string
        protein: z.number().optional(),
        carbs: z.number().optional(),
        fat: z.number().optional()
      }),
      profile: z.any(),
      nearbyMeals: z.array(z.object({
        dayIndex: z.number(),
        mealIndex: z.number(),
        type: z.string(), // breakfast, lunch, dinner, etc.
        name: z.string(),
        calories: z.number(),
        time: z.string() // HH:mm format
      })).default([]),
      lang: z.string().default('en')
    }).parse(req.body);

    const { loggedFood, profile, nearbyMeals, lang } = body;

    if (nearbyMeals.length === 0) {
      return reply.send({ shouldReplace: false, suggestion: null });
    }

    // Find the closest meal by time
    const loggedTime = new Date(loggedFood.timestamp);
    const loggedMinutes = loggedTime.getHours() * 60 + loggedTime.getMinutes();
    
    let closestMeal = nearbyMeals[0];
    let minDiff = Infinity;
    
    nearbyMeals.forEach(meal => {
      const [hours, minutes] = meal.time.split(':').map(Number);
      const mealMinutes = hours * 60 + minutes;
      const diff = Math.abs(loggedMinutes - mealMinutes);
      if (diff < minDiff && diff <= 120) { // Within 2 hours
        minDiff = diff;
        closestMeal = meal;
      }
    });

    if (minDiff > 120) {
      return reply.send({ shouldReplace: false, suggestion: null });
    }

    const calorieDiff = loggedFood.calories - closestMeal.calories;
    const isHigher = calorieDiff > 0;
    const diffAbs = Math.abs(calorieDiff);

    const prompt = `
    ACT AS GUARDIAN AI - MEAL REPLACEMENT ADVISOR.
    User just logged: "${loggedFood.name}" (${loggedFood.calories} kcal) at ${loggedTime.toLocaleTimeString()}.
    
    NEARBY PLAN MEAL:
    - Type: ${closestMeal.type}
    - Name: ${closestMeal.name}
    - Calories: ${closestMeal.calories} kcal
    - Scheduled Time: ${closestMeal.time}
    - Time Difference: ${Math.round(minDiff)} minutes
    
    USER PROFILE:
    - Primary Goal: ${profile.primaryGoal || 'maintain'}
    - Fitness Level: ${profile.fitnessLevel || 'intermediate'}
    - Daily Target: ${profile.target || 2000} kcal
    
    CALORIE DIFFERENCE: ${isHigher ? '+' : ''}${calorieDiff} kcal (${isHigher ? 'higher' : 'lower'} than planned)
    
    GENERATE REPLACEMENT SUGGESTION:
    
    ${isHigher ? `
    - WARNING: Tracked meal is ${diffAbs} kcal MORE than planned ${closestMeal.type}
    - Suggest: "Bunu ${closestMeal.type === 'breakfast' ? 'kahvaltı' : closestMeal.type === 'lunch' ? 'öğle yemeği' : closestMeal.type === 'dinner' ? 'akşam yemeği' : closestMeal.type} yerine mi yedin?"
    - Action: Replace plan meal with logged food
    - Impact: ${diffAbs} kcal surplus - suggest mitigation if > 100 kcal
    ` : `
    - INFO: Tracked meal is ${diffAbs} kcal LESS than planned ${closestMeal.type}
    - Suggest: "Bunu ${closestMeal.type === 'breakfast' ? 'kahvaltı' : closestMeal.type === 'lunch' ? 'öğle yemeği' : closestMeal.type === 'dinner' ? 'akşam yemeği' : closestMeal.type} yerine mi yedin?"
    - Action: Replace plan meal with logged food
    - Impact: ${diffAbs} kcal deficit - may need to add snack later
    `}
    
    OUTPUT JSON:
    {
      "shouldReplace": true,
      "suggestion": {
        "title": "Bunu ${closestMeal.type === 'breakfast' ? 'kahvaltı' : closestMeal.type === 'lunch' ? 'öğle yemeği' : closestMeal.type === 'dinner' ? 'akşam yemeği' : closestMeal.type} yerine mi yedin?",
        "description": "${loggedFood.name} (${loggedFood.calories} kcal) planlanan ${closestMeal.name} (${closestMeal.calories} kcal) yerine geçsin mi?",
        "calorieDiff": ${calorieDiff},
        "isHigher": ${isHigher},
        "planMeal": {
          "dayIndex": ${closestMeal.dayIndex},
          "mealIndex": ${closestMeal.mealIndex},
          "type": "${closestMeal.type}",
          "name": "${closestMeal.name}",
          "calories": ${closestMeal.calories}
        },
        "loggedFood": {
          "name": "${loggedFood.name}",
          "calories": ${loggedFood.calories}
        },
        "mitigation": ${diffAbs > 100 && isHigher ? `"Bu değişiklik ${diffAbs} kcal fazla kalori ekliyor. Surplus mitigation önerilir."` : diffAbs > 100 && !isHigher ? `"Bu değişiklik ${diffAbs} kcal eksik kalori bırakıyor. Daha sonra bir atıştırmalık eklemeyi düşünün."` : '"Değişiklik minimal, ek aksiyon gerekmiyor."'}
      }
    }
    `;

    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${response.status})` : `Gemini API error: ${errorText}`);
      }

      const data: any = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = cleanGeminiJson(text);
      const parsed = JSON.parse(cleaned);

      return reply.send(parsed);
    } catch (e: any) {
      console.error('Meal replacement analysis failed', e);
      // Fallback: simple heuristic
      return reply.send({
        shouldReplace: true,
        suggestion: {
          title: `Bunu ${closestMeal.type === 'breakfast' ? 'kahvaltı' : closestMeal.type === 'lunch' ? 'öğle yemeği' : closestMeal.type === 'dinner' ? 'akşam yemeği' : closestMeal.type} yerine mi yedin?`,
          description: `${loggedFood.name} (${loggedFood.calories} kcal) planlanan ${closestMeal.name} (${closestMeal.calories} kcal) yerine geçsin mi?`,
          calorieDiff,
          isHigher,
          planMeal: {
            dayIndex: closestMeal.dayIndex,
            mealIndex: closestMeal.mealIndex,
            type: closestMeal.type,
            name: closestMeal.name,
            calories: closestMeal.calories
          },
          loggedFood: {
            name: loggedFood.name,
            calories: loggedFood.calories
          },
          mitigation: diffAbs > 100 && isHigher 
            ? `Bu değişiklik ${diffAbs} kcal fazla kalori ekliyor. Surplus mitigation önerilir.`
            : diffAbs > 100 && !isHigher
            ? `Bu değişiklik ${diffAbs} kcal eksik kalori bırakıyor. Daha sonra bir atıştırmalık eklemeyi düşünün.`
            : 'Değişiklik minimal, ek aksiyon gerekmiyor.'
        }
      });
    }
  });
}