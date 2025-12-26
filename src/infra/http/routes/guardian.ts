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

const GEMINI_MODEL = 'models/gemini-2.5-flash';
const GEN_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent`;

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
          - PRIORITY: "plug" -> Suggest small snack if crash risk (e.g. low blood sugar).
          - PRIORITY: "downshift" -> Reduce future meal (Target: [${availableMeals.join(', ')}]) to keep deficit steady.
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
            // spread_today: { "targetMeal": "string", "amount": number }
            // downshift: { "targetMeal": "string", "reduction": number }
            // plug: { "replacement": "string", "calories": number }
            // bank_credit: { "amount": number, "description": "string" }
            // bank_debt: { "volume": number, "description": "string" }
          }
        }
      ]
    }
    
    Return 2-4 remedies. Language: ${lang}.
    `;

    try {
      const res = await fetch(GEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.geminiApiKey
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const result = JSON.parse(cleanGeminiJson(text) || '{}');

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
      ).catch(console.error);

      return reply.send(result);
    } catch (e: any) {
      console.error("Guardian analysis failed", e);
      return reply.send({
        isSafe: true,
        impactLevel: 'low',
        warning: "Confirm deletion?",
        remedies: [{ id: 'err_del', type: 'none', title: 'Delete', description: '', actionLabel: 'Delete' }]
      });
    }
  });

  // Apply deletion remedy
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
          console.log(`[Guardian] Applied ${remedy.type} to ${mealId}: ${calories} cal`);
        } else {
          console.warn(`[Guardian] Could not find meal ID for name '${targetName}'.`);
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
        const targetDate = remedy.data?.targetDate || date;
        const lastSkip = newSkipped[newSkipped.length - 1];
        if (lastSkip) {
          lastSkip.rescheduleTo = targetDate;
          lastSkip.rescheduled = true;
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
        [JSON.stringify({ ...profileData, skippedItems: newSkipped, dailyMealModifications: newMods }), user.userId]
      );

      await client.query(`INSERT INTO guardian_actions(user_id, action_type, item_type, item_title, payload) VALUES($1,$2,$3,$4,$5)`,
        [user.userId, 'remedy', item.type || 'unknown', item.title || 'Item', JSON.stringify({ remedy, success: true })]);

      await client.query('COMMIT');
      return reply.send({ success: true, skippedItems: newSkipped, modifications: newMods });

    } catch (e: any) {
      await client.query('ROLLBACK');
      console.error("Apply remedy failed", e);
      return reply.status(500).send({ error: e.message });
    } finally {
      client.release();
    }
  });

  // Analyze surplus
  app.post('/guardian/analyze-surplus', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'API_KEY missing' });

    const body = z.object({
      surplus: z.number(),
      profile: z.any(),
      nextMealName: z.string().optional(),
      nextMealCalories: z.number().optional(),
      lang: z.string().default('en')
    }).parse(req.body);

    const { surplus, profile, lang } = body;
    const prompt = `ACT AS GUARDIAN AI. User has ${surplus}kcal surplus. Goal: ${profile.primaryGoal}. 
    Generate 4 strategies (athlete, chef, hybrid, banker). Return JSON { strategies: { athlete: {...}, ... } }. Language: ${lang}.`;

    try {
      const res = await fetch(GEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const result = JSON.parse(cleanGeminiJson(text));

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
    const prompt = `GUARDIAN AI - EXTRA TRAINING REVIEW. New: ${exerciseName}. Muscles: ${muscleGroups.join(',')}. Plan: ${todaysPlan.map((p: any) => p?.title).join(',')}. Profile: ${profile.primaryGoal}. Detect overload. Return JSON { warning, suggestions }.`;

    try {
      const res = await fetch(GEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(cleanGeminiJson(text) || '{}');
      return reply.send({ warning: parsed.warning || '', suggestions: parsed.suggestions?.slice(0, 3) || [] });
    } catch (e: any) {
      return reply.send({ warning: "Consider recovery.", suggestions: [] });
    }
  });

  // Analyze meal replacement
  app.post('/guardian/analyze-meal-replacement', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as any).user;
    if (!env.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });
    // Use the same model for simplicity
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
      const res = await fetch(GEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return reply.send(JSON.parse(cleanGeminiJson(text)));
    } catch (e: any) {
      return reply.send({ shouldReplace: false });
    }
  });

  app.get('/guardian/actions', { preHandler: authGuard }, async (req) => {
    const user = (req as any).user;
    const { rows } = await pool.query(`SELECT id, action_type, item_type, item_title, payload, created_at FROM guardian_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.userId]);
    return rows.map((r: any) => ({ id: r.id, actionType: r.action_type, itemType: r.item_type, itemTitle: r.item_title, payload: r.payload, createdAt: r.created_at }));
  });
}