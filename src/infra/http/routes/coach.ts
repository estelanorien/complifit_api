import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../hooks/auth.js';
import { pool } from '../../db/pool.js';
import { AiService } from '../../../application/services/aiService.js';
import { AuthenticatedRequest } from '../types.js';

const ai = new AiService();

export async function coachRoutes(app: FastifyInstance) {

  const chatSchema = z.object({
    history: z.array(z.unknown()),
    lang: z.string().default('en'),
    contextData: z.unknown().optional()
  });

  app.post('/coach/training', { preHandler: authGuard }, async (req, reply) => {
    const { history, lang } = chatSchema.parse(req.body);
    try {
      const { text } = await ai.generateChat({
        messages: history as any[],
        systemPrompt: `You are an elite Strength Coach. Language: ${lang}. Be concise, motivational, and safety-focused. Avoid "As an AI" disclaimers.`,
        taskType: 'coach_chat',
      });
      return reply.send({ reply: text || "I'm refining your plan, please ask again." });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Training coach error', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Training coach failed' });
    }
  });

  app.post('/coach/nutrition', { preHandler: authGuard }, async (req, reply) => {
    const { history, lang, contextData } = chatSchema.parse(req.body);
    try {
      let contextPrompt = '';
      if (contextData) {
        contextPrompt = `\nCURRENT CONTEXT:\n${JSON.stringify(contextData).slice(0, 5000)}\nUse this data to answer restaurant or meal comparisons.`;
      }
      const { text } = await ai.generateChat({
        messages: history as any[],
        systemPrompt: `You are an expert Dietitian. Language: ${lang}. Be concise, scientific, and encouraging. Avoid "As an AI" disclaimers. ${contextPrompt}`,
        taskType: 'coach_chat',
      });
      return reply.send({ reply: text || "I'm reviewing your meals, please retry." });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Nutrition coach error', message: error.message, requestId: req.id });
      const isProduction = process.env.NODE_ENV === 'production';
      return reply.status(500).send({
        error: isProduction ? 'Nutrition coach service unavailable' : (error.message || 'Nutrition coach failed')
      });
    }
  });

  const tipsSchema = z.object({
    recentFoods: z.array(z.string()),
    profile: z.record(z.any()),
    lang: z.string().default('en')
  });

  app.post('/coach/dietary-tips', { preHandler: authGuard }, async (req, reply) => {
    const { recentFoods, profile, lang } = tipsSchema.parse(req.body);
    const prompt = `ANALYZE DIET TRENDS.
Recent foods: ${recentFoods.join(', ') || 'None'}.
Profile Goal: ${profile?.primaryGoal}. Diet: ${profile?.dietaryPreference}.
Provide ONE key dietary insight/tip and ONE suggested action (snack/meal adjustment).
Language: ${lang}.
Return JSON:
{
  "tip": "string",
  "suggestedAction": {
    "item": "string",
    "calories": number,
    "meal": "snack" | "breakfast" | "lunch" | "dinner",
    "reason": "string"
  }
}`;
    try {
      const { data } = await ai.generateStructuredOutput({ prompt, taskType: 'dietary_tips' });
      return reply.send({ insight: data });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Dietary tips error', message: error.message, requestId: req.id });
      const isProduction = process.env.NODE_ENV === 'production';
      return reply.status(500).send({
        error: isProduction ? 'Dietary tips service unavailable' : (error.message || 'Dietary tips failed')
      });
    }
  });

  const shoppingSchema = z.object({
    items: z.array(z.string()),
    lang: z.string().default('en')
  });

  app.post('/coach/shopping-list', { preHandler: authGuard }, async (req, reply) => {
    const { items, lang } = shoppingSchema.parse(req.body);
    const prompt = `ORGANIZE SHOPPING LIST.
Raw Items: ${items.join(', ')}.
Tasks:
1. Consolidate duplicates (e.g. "2 eggs" + "3 eggs" -> "5 eggs").
2. Categorize items.
3. Sort by category (Produce, Protein, Dairy, Pantry, etc).
Return JSON array of strings: ["Category: Item", ...].
Language: ${lang}.`;
    try {
      const { data } = await ai.generateStructuredOutput({ prompt, taskType: 'shopping_list' });
      return reply.send({ items: data || items });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Shopping consolidate error', message: error.message, requestId: req.id });
      const isProduction = process.env.NODE_ENV === 'production';
      return reply.status(500).send({
        error: isProduction ? 'Shopping list service unavailable' : (error.message || 'Shopping consolidation failed')
      });
    }
  });

  const explorerSchema = z.object({
    profile: z.record(z.any()),
    lang: z.string().default('en')
  });

  app.post('/coach/culinary-explorer', { preHandler: authGuard }, async (req, reply) => {
    const { profile, lang } = explorerSchema.parse(req.body);
    const prompt = `CULINARY PASSPORT.
User prefers cuisines: ${(profile?.preferredCuisines || []).join(', ') || 'None'}.
Dietary preference: ${profile?.dietaryPreference || 'standard'}.
Avoid ingredients: ${(profile?.excludedIngredients || []).join(', ') || 'None'}.
Suggest ONE adventurous meal from a cuisine they rarely eat.
Return JSON:
{
  "name": "...",
  "calories": number,
  "time": "30 min",
  "ingredients": ["..."],
  "instructions": ["..."],
  "cuisine": "Country",
  "prepTips": ["tip"],
  "benefits": ["reason"]
}
Language: ${lang}.`;
    try {
      const { data } = await ai.generateStructuredOutput({ prompt, taskType: 'culinary_explorer' });
      return reply.send({ meal: data });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Culinary explorer error', message: error.message, requestId: req.id });
      const isProduction = process.env.NODE_ENV === 'production';
      return reply.status(500).send({
        error: isProduction ? 'Culinary explorer service unavailable' : (error.message || 'Explorer failed')
      });
    }
  });

  // Log adjustment decisions
  app.post('/coach/adjustments', { preHandler: authGuard }, async (req, reply) => {
    const user = (req as AuthenticatedRequest).user;
    const body = req.body as Record<string, unknown>;

    try {
      await pool.query(
        `INSERT INTO coach_adjustments(id, user_id, adjustment_data, created_at)
         VALUES(gen_random_uuid(), $1, $2, now())`,
        [user.userId, JSON.stringify(body)]
      );
      return reply.send({ success: true });
    } catch (e: unknown) {
      // Table might not exist yet - log and return success to not block the client
      const error = e as { code?: string; message?: string };
      if (error.code === '42P01') {
        // Table doesn't exist - store in profile_data as fallback
        try {
          await pool.query(
            `UPDATE user_profiles
             SET profile_data = jsonb_set(
               COALESCE(profile_data, '{}'::jsonb),
               '{adjustmentLog}',
               COALESCE(profile_data->'adjustmentLog', '[]'::jsonb) || $1::jsonb
             ),
             updated_at = now()
             WHERE user_id = $2`,
            [JSON.stringify([body]), user.userId]
          );
        } catch { /* best effort */ }
        return reply.send({ success: true });
      }
      req.log.error({ error: 'Coach adjustment log failed', message: error.message });
      return reply.status(500).send({ error: 'Failed to log adjustment' });
    }
  });

  // General vitality agent (replaces frontend agent)
  app.post('/coach/agent', { preHandler: authGuard }, async (req, reply) => {
    const body = z.object({
      history: z.array(z.unknown()),
      profile: z.record(z.any()),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { history, profile, lang } = body;

      const systemPrompt = `You are VITALITY AI - An intelligent health and fitness assistant.

User Profile:
- Goal: ${profile?.primaryGoal || 'general fitness'}
- Fitness Level: ${profile?.fitnessLevel || 'intermediate'}
- Conditions: ${(profile?.conditions || []).join(', ') || 'None'}
- Dietary Preference: ${profile?.dietaryPreference || 'standard'}

Your role:
1. Provide personalized health, fitness, and nutrition advice
2. Answer questions about workouts, meals, and lifestyle
3. Be supportive, motivational, and scientifically accurate
4. Avoid "As an AI" disclaimers - be conversational
5. Use the user's profile context to give relevant advice

Language: ${lang}`;

      const { text } = await ai.generateChat({
        messages: history as any[],
        systemPrompt,
        taskType: 'coach_chat',
      });
      return reply.send({ reply: text || "I'm here to help! What would you like to know?" });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Agent error', message: error.message, requestId: req.id });
      const isProduction = process.env.NODE_ENV === 'production';
      return reply.status(500).send({
        error: isProduction ? 'Agent service unavailable' : (error.message || 'Agent failed')
      });
    }
  });
}
