import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fetch from 'node-fetch';
import { authGuard } from '../hooks/auth.js';
import { env } from '../../../config/env.js';

const buildGeminiPayload = (history: any[], systemText: string) => ({
  contents: history,
  systemInstruction: {
    role: 'system',
    parts: [{ text: systemText }]
  }
});

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

async function callGemini(payload: any) {
  // Use header-based auth instead of query param for security
  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.geminiApiKey
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errorText = await res.text();
    // Don't expose full error details in production
    const isProduction = process.env.NODE_ENV === 'production';
    throw new Error(isProduction
      ? `AI service error (${res.status})`
      : `Gemini error ${res.status}: ${errorText}`);
  }
  const data: any = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

export async function coachRoutes(app: FastifyInstance) {
  const ensureKey = (reply: any) => {
    if (!env.geminiApiKey) {
      reply.status(500).send({ error: 'GEMINI_API_KEY missing on backend' });
      return false;
    }
    return true;
  };

  const chatSchema = z.object({
    history: z.array(z.unknown()),
    lang: z.string().default('en'),
    contextData: z.unknown().optional()
  });

  app.post('/coach/training', { preHandler: authGuard }, async (req, reply) => {
    if (!ensureKey(reply)) return;
    const { history, lang } = chatSchema.parse(req.body);
    try {
      const text = await callGemini(buildGeminiPayload(
        history,
        `You are an elite Strength Coach. Language: ${lang}. Be concise, motivational, and safety-focused. Avoid "As an AI" disclaimers. Use Google Maps tool ideas conceptually if asked, but respond in text.`
      ));
      return reply.send({ reply: text || "I'm refining your plan, please ask again." });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Training coach error', message: error.message, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Training coach failed' });
    }
  });

  app.post('/coach/nutrition', { preHandler: authGuard }, async (req, reply) => {
    if (!ensureKey(reply)) return;
    const { history, lang, contextData } = chatSchema.parse(req.body);
    try {
      let contextPrompt = '';
      if (contextData) {
        contextPrompt = `
        CURRENT CONTEXT:
        ${JSON.stringify(contextData).slice(0, 5000)}
        Use this data to answer restaurant or meal comparisons.
        `;
      }
      const text = await callGemini(buildGeminiPayload(
        history,
        `You are an expert Dietitian. Language: ${lang}. Be concise, scientific, and encouraging. Avoid "As an AI" disclaimers. ${contextPrompt}`
      ));
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
    profile: z.any(), // TODO: define UserProfile schema
    lang: z.string().default('en')
  });

  app.post('/coach/dietary-tips', { preHandler: authGuard }, async (req, reply) => {
    if (!ensureKey(reply)) return;
    const { recentFoods, profile, lang } = tipsSchema.parse(req.body);
    const prompt = `
    ANALYZE DIET TRENDS.
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
    }
    `;
    try {
      const text = await callGemini({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      });
      return reply.send({ insight: text ? JSON.parse(text) : null });
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
    if (!ensureKey(reply)) return;
    const { items, lang } = shoppingSchema.parse(req.body);
    const prompt = `
    ORGANIZE SHOPPING LIST.
    Raw Items: ${items.join(', ')}.
    Tasks:
    1. Consolidate duplicates (e.g. "2 eggs" + "3 eggs" -> "5 eggs").
    2. Categorize items.
    3. Sort by category (Produce, Protein, Dairy, Pantry, etc).
    Return JSON array of strings: ["Category: Item", ...].
    Language: ${lang}.
    `;
    try {
      const text = await callGemini({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      });
      return reply.send({ items: text ? JSON.parse(text) : items });
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
    profile: z.any(), // TODO: define UserProfile schema
    lang: z.string().default('en')
  });

  app.post('/coach/culinary-explorer', { preHandler: authGuard }, async (req, reply) => {
    if (!ensureKey(reply)) return;
    const { profile, lang } = explorerSchema.parse(req.body);
    const prompt = `
    CULINARY PASSPORT.
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
    Language: ${lang}.
    `;
    try {
      const text = await callGemini({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      });
      return reply.send({ meal: text ? JSON.parse(text) : null });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'Culinary explorer error', message: error.message, requestId: req.id });
      const isProduction = process.env.NODE_ENV === 'production';
      return reply.status(500).send({
        error: isProduction ? 'Culinary explorer service unavailable' : (error.message || 'Explorer failed')
      });
    }
  });

  // General vitality agent (replaces frontend agent)
  app.post('/coach/agent', { preHandler: authGuard }, async (req, reply) => {
    if (!ensureKey(reply)) return;

    const body = z.object({
      history: z.array(z.unknown()),
      profile: z.any(), // TODO: define UserProfile schema
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { history, profile, lang } = body;

      const systemPrompt = `
      You are VITALITY AI - An intelligent health and fitness assistant.
      
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
      
      Language: ${lang}
      `;

      const text = await callGemini(buildGeminiPayload(history, systemPrompt));
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

