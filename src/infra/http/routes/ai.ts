
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiService } from '../../../application/services/aiService.js';
import { claudeService } from '../../../application/services/ClaudeService.js';
import { aiRouter } from '../../../application/services/AIRouter.js';
import { tryLocalFoodLookup } from '../../../application/services/foodLookupService.js';
import { pool } from '../../db/pool.js';
import { authGuard } from '../hooks/auth.js';
import fetch from 'node-fetch';
import { aiConfig } from '../../../config/ai.js';
import { recordApiCall } from '../../../services/aiDataCollector.js';
import { AuthenticatedRequest, GeminiPart, GeminiResponse } from '../types.js';
import { logger } from '../../../infra/logger.js';

const textSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional()
});

const imageSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional()
});

const generateSchema = z.object({
  parts: z.array(z.unknown()),
  model: z.string().optional(),
  generationConfig: z.record(z.unknown()).optional(),
  tools: z.array(z.unknown()).optional()
});

const foodLogSchema = z.object({
  text: z.string().optional(),
  imageBase64: z.string().optional(),
  contextMeals: z.array(z.record(z.unknown())).optional(),
  lang: z.string().optional()
});

let foodCacheReady = false;

const ensureFoodCacheTable = async () => {
  if (foodCacheReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS food_analysis_cache (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cache_key text UNIQUE,
      text_input text,
      lang text,
      response jsonb,
      created_at timestamptz DEFAULT now()
    );
  `);
  foodCacheReady = true;
};

/**
 * Sanitize user input before including in AI prompts to prevent prompt injection.
 * Removes characters that could escape prompt context or manipulate AI behavior.
 */
function sanitizeUserInput(text: string | undefined | null): string {
  if (!text) return '';
  return text
    // Remove structural characters that could escape context
    .replace(/[`]/g, "'")                                    // Backticks to single quotes
    .replace(/\{\{|\}\}/g, '')                               // Template literals
    .replace(/\[\[|\]\]/g, '')                               // Wiki-style brackets
    // Remove role markers that could override system prompts
    .replace(/\b(system|assistant|user|model|human|ai)\s*:/gi, '$1 -')
    // Remove markdown code blocks that could contain instructions
    .replace(/```[\s\S]*?```/g, '[code block removed]')
    // Remove XML-like tags that could be interpreted as instructions
    .replace(/<\/?(?:system|prompt|instruction|ignore|override)[^>]*>/gi, '')
    // Limit length to prevent context overflow
    .slice(0, 2000)
    .trim();
}

/**
 * Extract JSON from AI response text robustly.
 * Handles various response formats and common issues.
 */
function extractJsonFromResponse(text: string): object | null {
  if (!text) return null;

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to fallbacks
  }

  // Remove markdown code blocks
  let cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Try parsing cleaned text
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue to fallbacks
  }

  // Find JSON object or array boundaries
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Continue to fix common issues
    }

    // Try to fix common JSON issues
    let fixedJson = jsonMatch[1]
      .replace(/,\s*([}\]])/g, '$1')           // Remove trailing commas
      .replace(/'/g, '"')                       // Single to double quotes (careful with apostrophes)
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); // Quote unquoted keys

    try {
      return JSON.parse(fixedJson);
    } catch {
      // Give up
    }
  }

  return null;
}

export async function aiRoutes(app: FastifyInstance) {
  const ai = new AiService();

  // Basit rate limit, uygulama geneli rate-limit varsa kaldırılabilir
  app.post('/ai/text', { preHandler: authGuard }, async (req, reply) => {
    const startTime = Date.now();
    const parsed = textSchema.parse(req.body);
    const result = await ai.generateText(parsed);

    // Record for AI training (fire-and-forget)
    const user = (req as AuthenticatedRequest).user;
    recordApiCall({
      userId: user?.userId || 'anonymous',
      callType: 'text_generation',
      apiProvider: 'gemini',
      modelVersion: parsed.model || 'gemini-3-flash-preview',
      endpoint: '/ai/text',
      requestPrompt: sanitizeUserInput(parsed.prompt),
      responseRaw: result,
      latencyMs: Date.now() - startTime
    }).catch(() => {});

    return reply.send(result);
  });

  app.post('/ai/image', { preHandler: authGuard }, async (req, reply) => {
    const startTime = Date.now();
    const inputSchema = imageSchema.extend({
      referenceImage: z.string().optional() // Base64 image data
    });

    const parsed = inputSchema.parse(req.body);
    const result = await ai.generateImage(parsed);

    // Record for AI training (fire-and-forget)
    const user = (req as AuthenticatedRequest).user;
    recordApiCall({
      userId: user?.userId || 'anonymous',
      callType: 'image_generation',
      apiProvider: 'gemini',
      modelVersion: 'gemini-2.5-flash-image',
      endpoint: '/ai/image',
      requestPrompt: sanitizeUserInput(parsed.prompt),
      requestContext: { hasReferenceImage: !!parsed.referenceImage },
      responseRaw: { hasImage: !!result },
      latencyMs: Date.now() - startTime
    }).catch(() => {});

    return reply.send(result);
  });

  // General Gemini proxy (server-side key)
  app.post('/ai/generate-content', { preHandler: authGuard }, async (req, reply) => {
    const startTime = Date.now();
    const body = generateSchema.parse(req.body || {});
    const { parts, model = 'models/gemini-3-flash-preview', generationConfig, tools } = body;

    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig,
          tools
        })
      });
      if (!res.ok) {
        const txt = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini generate error ${res.status}: ${txt}`);
      }
      const data: any = await res.json();
      const contentParts = data?.candidates?.[0]?.content?.parts || [];
      const firstText = contentParts.find((p: any) => p?.text)?.text || '';

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'content_generation',
        apiProvider: 'gemini',
        modelVersion: model,
        endpoint: '/ai/generate-content',
        requestPrompt: parts.map((p: any) => p?.text || '[non-text]').join(' ').substring(0, 500),
        requestContext: { hasTools: !!tools, partsCount: parts.length },
        responseRaw: { text: firstText.substring(0, 500), partsCount: contentParts.length },
        latencyMs: Date.now() - startTime
      }).catch(() => {});

      return reply.send({ text: firstText, parts: contentParts });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'generate-content proxy failed', e, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'generate failed' });
    }
  });

  // Food log analysis (Gemini via backend, so API key stays server-side)
  app.post('/ai/food-log', { preHandler: authGuard }, async (req, reply) => {
    const body = foodLogSchema.parse(req.body || {});
    const { text, imageBase64, contextMeals = [], lang = 'en' } = body;

    // Validate: must have either text or image
    if (!text && !imageBase64) {
      return reply.status(400).send({
        error: 'Either text or imageBase64 must be provided',
        name: 'Extra Food',
        calories: 350,
        macros: { protein: 20, carbs: 35, fat: 12 },
        status: 'extra',
        matchIndex: -1,
        confidence: 0
      });
    }

    await ensureFoodCacheTable().catch(() => { });

    // LOCAL DB LOOKUP — short-circuit AI for known foods (text-only, zero cost)
    if (text && !imageBase64) {
      const localResult = tryLocalFoodLookup(text, lang, contextMeals as any);
      if (localResult) {
        req.log.info({ source: 'local_db', name: localResult.name, calories: localResult.calories, message: 'Food resolved from local DB (zero AI cost)' });
        return reply.send(localResult);
      }
    }

    const mealContext = contextMeals
      .map((m: any, i: number) => `${i}: ${m?.recipe?.name || m?.recipe?.title || 'meal'} (${m?.recipe?.calories ?? 'unk'} kcal)`)
      .join(', ');

    // Build prompt based on whether we have image or text
    let prompt = '';
    const parts: any[] = [];

    if (imageBase64) {
      // CHECK PRO TIER
      const user = (req as AuthenticatedRequest).user;
      const { rows } = await pool.query('SELECT subscription_tier FROM profiles WHERE user_id = $1', [user.userId]);
      const tier = rows[0]?.subscription_tier || 'free';

      if (tier !== 'pro') {
        return reply.status(403).send({
          error: 'Subscription Required',
          message: 'Photo logging is a Pro feature. Upgrade to unlock!',
          isProContent: true
        });
      }

      // IMAGE ANALYSIS — trimmed prompt (calorie densities are in system prompt)
      const turkishBlock = (lang === 'tr') ? `
For Turkish dishes, estimate: Döner ~280kcal/200g, Lahmacun ~280kcal/piece, Pide ~500kcal/whole, Köfte ~80kcal/piece, Börek ~300kcal/150g, Çorba ~180kcal/bowl, Baklava ~200kcal/piece.
Turkish translations: Tavuk=Chicken, Et=Meat, Balık=Fish, Pilav=Rice, Makarna=Pasta, Salata=Salad, Çorba=Soup.` : '';

      prompt = `FOOD IMAGE ANALYSIS.
Analyze the photo. If it contains NO food, set "isFood"=false, "errorType"="not_food", calories/macros=0.

PORTION ESTIMATION:
- Estimate weight in grams using plate size and visual references (deck of cards=85g meat, tennis ball=1 cup)
- Count individual items, estimate plate fullness
- Identify each component: protein (grams), carbs (grams), vegetables, fats/oils, bread/sides
${turkishBlock}
MATCHING:
- Planned meals: [${mealContext}].
- Fuzzy-match photo to planned meal. If main ingredients overlap, status="matched" with matchIndex (0-based). Otherwise status="extra".

NEVER return default 350/20/35/12. Calculate from visual estimation. Sum all components.
Ensure: protein*4 + carbs*4 + fat*9 ≈ total calories (10% tolerance).

Return JSON: { "name": string, "calories": number, "macros": {"protein": number, "carbs": number, "fat": number}, "status": "matched"|"extra", "matchIndex": number, "confidence": 0-100, "isFood": boolean, "errorType": "ok"|"not_food"|"unrecognized_food", "message": string }`;

      // Add image first, then text context if any, then prompt
      const mime = imageBase64.includes('png') ? 'image/png' : 'image/jpeg';
      parts.push({ inlineData: { mimeType: mime, data: imageBase64.split(',')[1] } });
      if (text && text.trim()) {
        parts.push({ text: `User context/description: "${sanitizeUserInput(text)}"` });
      }
      parts.push({ text: prompt });
    } else if (text) {
      // TEXT-ONLY ANALYSIS
      prompt = `
      ANALYZE FOOD LOG (LANGUAGE-AGNOSTIC, QUANTITY-AWARE).
      - The user text may be in ANY language/dialect/transliteration. Detect it yourself.
      - ALWAYS return a best-effort JSON, never refuse.
      - No cultural filtering. Assume the mentioned food exists; estimate realistically.
      - Planned meals today: [${mealContext}].
      - FIRST, decide if the text actually describes food/meal consumption.
        * If text is clearly NOT about food (e.g. mood, workout, random sentence), set "isFood" = false, "errorType" = "not_food", calories/macros = 0, status="extra", matchIndex=-1, confidence=0 and add a short message explaining that no food was found in the text.
      - Detect QUANTITY in the text: numbers + (porsiyon/portion/serving/adet/piece/pcs/x2/gram/gr/g/kg/kilo/yarım/half/double/çeyrek/quarter) or words (bir=1, iki=2, üç=3, dört=4, beş=5).
      - QUANTITY DETECTION RULES:
        * If grams mentioned: Use exact grams (e.g., "200g tavuk" = 200g chicken)
        * If portion/serving mentioned: Standard serving sizes:
          - Protein (meat/fish): 1 serving = 120-150g (raw) or 100-120g (cooked)
          - Carbs (rice/pasta): 1 serving = 150-200g cooked (≈80-100g dry)
          - Vegetables: 1 serving = 100-150g
          - Bread: 1 serving = 50-60g (1 slice or 1 small roll)
        * If "yarım/half": Multiply standard serving by 0.5
        * If "double/çift": Multiply standard serving by 2.0
        * If no quantity mentioned: Assume 1 standard serving
      - Calories and macros MUST reflect the consumed amount (quantity-adjusted). Do NOT use generic values.
      - Use ACCURATE caloric densities:
        * Lean proteins: 150-200 kcal/100g (chicken breast, fish, lean beef)
        * Fatty proteins: 250-350 kcal/100g (döner, köfte, fatty cuts)
        * Fried foods: Add 50-100 kcal/100g to base calories
        * Rice/Pasta (cooked): 130-150 kcal/100g
        * Bread: 250-300 kcal/100g
        * Vegetables (raw): 20-50 kcal/100g
        * Vegetables (cooked with oil): 100-200 kcal/100g
        * Oils/Sauces: 1 tbsp = ~120 kcal
      - Calculate macros accurately:
        * Protein: 4 kcal per gram
        * Carbs: 4 kcal per gram  
        * Fat: 9 kcal per gram
        * Ensure: (protein × 4) + (carbs × 4) + (fat × 9) ≈ total calories (±10% tolerance)
      
      Tasks:
      1) If text clearly does NOT describe any food, return isFood=false, errorType="not_food", calories/macros=0 and an explanatory message.
      2) Otherwise, identify the food name (keep original language if provided) and DETECTED QUANTITY.
      3) Calculate calories & macros (Protein/Carbs/Fat) for the SPECIFIC consumed amount:
         - Example: "200g tavuk göğsü" → 200g × 1.65 kcal/g = 330 kcal, 60g protein, 4g fat, 0g carbs
         - Example: "1 porsiyon döner" → 150g × 2.8 kcal/g = 420 kcal, 25g protein, 20g fat, 30g carbs
         - Example: "2 lahmacun" → 2 × 250 kcal = 500 kcal, 20g protein, 25g fat, 45g carbs
      4) Fuzzy-match against planned meals (case-insensitive). If no match, status = "extra", matchIndex = -1.
      
      Return JSON EXACTLY:
      {
          "name": "string",
          "calories": number,
          "macros": { "protein": number, "carbs": number, "fat": number },
          "status": "matched" | "extra",
          "matchIndex": number,
          "confidence": number,
          "isFood": boolean,
          "errorType": "ok" | "not_food" | "unrecognized_food",
          "message": "short explanation in the user's language"
      }
      Response language: keep detected language of input text if any; otherwise English.
      `;
      parts.push({ text: `User Log: "${sanitizeUserInput(text)}"` });
      parts.push({ text: prompt });
    }

    const model = 'models/gemini-3-flash-preview';

    // Helper function to ensure response has all required fields
    // CRITICAL: Only use defaults if AI didn't provide values. If AI provided values, use them!
    const ensureDefaults = (obj: any) => {
      if (!obj || typeof obj !== 'object') {
        req.log.warn('ensureDefaults: obj is not an object, using fallback');
        obj = {};
      }

      // default flags
      const explicitNotFood = obj.isFood === false || obj.errorType === 'not_food' || obj.errorType === 'unrecognized_food';
      obj.isFood = explicitNotFood ? false : (typeof obj.isFood === 'boolean' ? obj.isFood : true);
      obj.errorType = obj.errorType || 'ok';
      obj.message = obj.message || '';
      obj.name = obj.name || text || 'Extra Food';

      if (explicitNotFood) {
        obj.calories = 0;
        obj.macros = obj.macros || {};
        obj.macros.protein = 0;
        obj.macros.carbs = 0;
        obj.macros.fat = 0;
        obj.status = 'extra';
        obj.matchIndex = -1;
        obj.confidence = 0;
      } else {
        // CRITICAL: AI MUST provide calories and macros - NO defaults!
        // If AI didn't provide values, throw error instead of using defaults
        const hasCalories = typeof obj.calories === 'number' && obj.calories > 0;
        const hasMacros = obj.macros &&
          typeof obj.macros.protein === 'number' &&
          typeof obj.macros.carbs === 'number' &&
          typeof obj.macros.fat === 'number';
        // If AI didn't provide proper values, throw error instead of using defaults
        if (!hasCalories || !hasMacros) {
          req.log.error({
            requestId: req.id,
            hasCalories,
            hasMacros,
            message: '❌ ensureDefaults: AI did not provide required values!'
          });
          req.log.error({
            requestId: req.id,
            obj: JSON.stringify(obj, null, 2),
            message: 'AI response object'
          });
          throw new Error("AI response missing required calories or macros");
        }

        // AI provided values - use them directly, no defaults!
        obj.calories = obj.calories;
        obj.macros = {
          protein: obj.macros.protein,
          carbs: obj.macros.carbs,
          fat: obj.macros.fat
        };

        obj.status = obj.status || 'extra';
        obj.matchIndex = typeof obj.matchIndex === 'number' ? obj.matchIndex : -1;
        obj.confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
      }

      return obj;
    };

    try {
      // Build cache keys
      const textKey = `${lang}:${(text || '').trim().toLowerCase()}`;
      let imageKey = '';
      if (imageBase64) {
        // Fix: Do not use first 50 chars as headers are often identical
        // Use length + last 50 chars for better uniqueness without perf cost
        const imageData = imageBase64.split(',')[1] || imageBase64;
        const len = imageData.length;
        const suffix = imageData.substring(Math.max(0, len - 100));
        const imageHash = `${len}-${suffix.substring(0, 50)}`;
        imageKey = `${lang}:image:${imageHash}:${(text || '').trim().toLowerCase()}`;

        // Image cache enabled - using hash-based key for uniqueness
        // Cache helps reduce API costs and improve response time for similar images
      }

      // 1) Try cache: for image requests only use image-based key (to avoid wrong text-only reuse),
      //    for text-only requests use text-based key.
      try {
        // Priority 1: Exact match (image+text or image-only)
        if (imageKey) {
          const exactCached = await pool.query('SELECT response FROM food_analysis_cache WHERE cache_key = $1 LIMIT 1', [imageKey]);
          if (exactCached.rows.length > 0) {
            const cachedResp = exactCached.rows[0].response;
            req.log.info({ cachedResp, message: '📦 Cache hit (image)' });

            // Check if cached response has default values
            const isCachedDefault = cachedResp?.calories === 350 &&
              cachedResp?.macros?.protein === 20 &&
              cachedResp?.macros?.carbs === 35 &&
              cachedResp?.macros?.fat === 12;

            if (isCachedDefault) {
              req.log.error({ error: '🚨 Cached response has default values - ignoring cache and recalculating', requestId: req.id });
              // Don't return cached - let it fall through to AI call
            } else {
              return reply.send(ensureDefaults(cachedResp));
            }
          }
        }

        // Priority 2: Text-based cache (only when there is NO image)
        // This helps when same food is logged multiple times by text.
        if (!imageBase64 && text && text.trim()) {
          const textCached = await pool.query('SELECT response FROM food_analysis_cache WHERE cache_key = $1 LIMIT 1', [textKey]);
          if (textCached.rows.length > 0) {
            const cachedResp = textCached.rows[0].response;
            req.log.info({ cachedResp, message: '📦 Cache hit (text)' });

            // Check if cached response has default values
            const isCachedDefault = cachedResp?.calories === 350 &&
              cachedResp?.macros?.protein === 20 &&
              cachedResp?.macros?.carbs === 35 &&
              cachedResp?.macros?.fat === 12;

            if (isCachedDefault) {
              req.log.error({ error: '🚨 Cached response has default values - ignoring cache and recalculating', requestId: req.id });
              // Don't return cached - let it fall through to AI call
            } else {
              return reply.send(ensureDefaults(cachedResp));
            }
          }
        }
      } catch (e) {
        req.log.warn({ error: e, requestId: req.id, message: 'food-log cache lookup failed' });
      }

      const foodSystemPrompt = `You are an expert nutritionist and food recognition AI. Your task is to analyze food images and text with EXTREME ACCURACY in calorie and macro estimation.

CRITICAL CALORIE CALCULATION RULES:
1. NEVER use generic or default values like 350 calories, 20g protein, 35g carbs, 12g fat.
2. If you return 350/20/35/12, your response will be REJECTED.
3. Always calculate based on ACTUAL VISUAL ESTIMATION or SPECIFIC QUANTITY mentioned.
4. For images: Estimate portion size visually using reference objects (deck of cards, tennis ball, thumb, plate size).
5. For text: Parse exact quantities (grams, portions, pieces) and calculate accordingly.
6. Use standard caloric densities per 100g:
   - Lean proteins: 150-200 kcal/100g
   - Fatty proteins: 250-350 kcal/100g
   - Fried foods: base + 50-100 kcal/100g
   - Rice/Pasta (cooked): 130-150 kcal/100g
   - Bread: 250-300 kcal/100g
   - Vegetables (raw): 20-50 kcal/100g
   - Vegetables (cooked with oil): 100-200 kcal/100g
   - Oils: 900 kcal/100g (1 tbsp = 120 kcal)
7. Calculate macros: protein x 4 + carbs x 4 + fat x 9 must approximate total calories (10% tolerance).
8. Sum ALL components: main dish + sides + sauces + bread + drinks = TOTAL calories.
9. Be REALISTIC: A typical restaurant meal is 600-1000 kcal, not 200-300 kcal.

Return ONLY valid JSON with these exact fields:
{ "name": string, "calories": number, "macros": { "protein": number, "carbs": number, "fat": number }, "status": "matched"|"extra", "matchIndex": number, "confidence": number (0-100), "isFood": boolean, "errorType": "ok"|"not_food"|"unrecognized_food", "message": string }`;

      let parsed: any = null;
      const foodRoute = aiRouter.route(imageBase64 ? 'food_log_image' : 'food_log_text');

      // Try Claude Opus first for superior food analysis accuracy
      if (foodRoute.provider === 'anthropic') {
        try {
          let claudeText: string;
          if (imageBase64) {
            const imgMime = imageBase64.includes('png') ? 'image/png' : 'image/jpeg';
            const imgData = imageBase64.split(',')[1] || imageBase64;
            const userContext = text ? `User description: "${sanitizeUserInput(text)}"\n\n` : '';
            claudeText = (await claudeService.analyzeImage({
              prompt: userContext + prompt,
              imageBase64: imgData,
              imageMimeType: imgMime as any,
              systemPrompt: foodSystemPrompt,
              model: foodRoute.model,
              maxTokens: foodRoute.maxOutputTokens || 4096,
              temperature: 0.3,
            })).text;
          } else {
            claudeText = (await claudeService.generateText({
              prompt: prompt + '\n\nReturn ONLY valid JSON, no explanations.',
              systemPrompt: foodSystemPrompt,
              model: foodRoute.model,
              maxTokens: foodRoute.maxOutputTokens || 4096,
              temperature: 0.3,
            })).text;
          }
          parsed = extractJsonFromResponse(claudeText);
        } catch (e: any) {
          logger.warn(`[ai/food-log] Claude failed, falling back to Gemini: ${e.message}`);
        }
      }

      // Gemini fallback
      if (!parsed) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiConfig.geminiApiKey },
          body: JSON.stringify({
            contents: [{ parts }],
            systemInstruction: { parts: [{ text: foodSystemPrompt }] },
            generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
          })
        });
        if (!res.ok) {
          const txt = await res.text();
          req.log.error({ requestId: req.id, status: res.status, responseText: txt, message: 'food-log proxy: non-200' });
          throw new Error(`Gemini food-log error ${res.status}: ${txt}`);
        }
        const data: any = await res.json();
        const responseParts: any[] = data?.candidates?.[0]?.content?.parts || [];

        for (const p of responseParts) {
          const candidateText = p?.text;
          if (!candidateText) continue;
          try {
            parsed = extractJsonFromResponse(candidateText);
            if (parsed) break;
          } catch { continue; }
        }

        if (!parsed) {
          const refusalText = responseParts.map((p: any) => p.text).join(' ');
          if (refusalText.toLowerCase().includes("cannot") || refusalText.toLowerCase().includes("safety")) {
            return reply.send({
              isFood: false, errorType: 'not_food', message: 'Image could not be processed (Safety/Policy).',
              name: 'Invalid Image', calories: 0, macros: { protein: 0, carbs: 0, fat: 0 },
              status: 'extra', matchIndex: -1, confidence: 0
            });
          }
          throw new Error("JSON parsing failed");
        }
      }

      // CRITICAL: Check if AI returned default values (this check MUST happen BEFORE ensureDefaults)
      req.log.info({ parsed, message: '=== CHECKING AI RESPONSE ===' });

      const isDefaultValues = parsed?.calories === 350 &&
        parsed?.macros?.protein === 20 &&
        parsed?.macros?.carbs === 35 &&
        parsed?.macros?.fat === 12;

      if (isDefaultValues) {
        req.log.error({
          requestId: req.id,
          parsed,
          message: '🚨🚨🚨 CRITICAL: AI returned default values (350/20/35/12)!'
        });
        req.log.error({
          requestId: req.id,
          message: 'AI did NOT calculate - rejecting response!'
        });
        req.log.error({
          requestId: req.id,
          response: JSON.stringify(parsed, null, 2),
          message: 'Full response'
        });
        throw new Error("AI returned default values (350/20/35/12) - recalculation needed");
      }

      // If we get here, AI provided non-default values - proceed with ensureDefaults
      const finalResp = ensureDefaults(parsed);
      req.log.info({
        requestId: req.id,
        calories: finalResp.calories,
        macros: finalResp.macros,
        message: '✅ AI provided calculated values'
      });

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'food_analysis',
        apiProvider: foodRoute.provider,
        modelVersion: foodRoute.model,
        endpoint: '/ai/food-log',
        requestPrompt: prompt,
        requestContext: { hasImage: !!imageBase64, mealContext, lang },
        responseRaw: finalResp,
        responseParsed: { name: finalResp.name, calories: finalResp.calories, macros: finalResp.macros }
      });

      // 2) Cache store (best effort)
      try {
        if (imageKey) {
          await pool.query(
            `INSERT INTO food_analysis_cache(cache_key, text_input, lang, response)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, text_input = EXCLUDED.text_input, lang = EXCLUDED.lang`,
            [imageKey, text || '', lang, finalResp]
          );
        }
        if (text && text.trim()) {
          // Only cache text-only requests on text key
          // If we have an image, the text is just context, so don't update the pure text cache with an image-based result
          // unless we want that text to forever map to that image result. 
          // Better to only cache text-key if this was a text-only request.
          if (!imageBase64) {
            await pool.query(
              `INSERT INTO food_analysis_cache(cache_key, text_input, lang, response)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, text_input = EXCLUDED.text_input, lang = EXCLUDED.lang`,
              [textKey, text || '', lang, finalResp]
            );
          }
        }
      } catch (e) {
        req.log.warn({ error: e, requestId: req.id, message: 'food-log cache save failed' });
      }

      return reply.send(finalResp);
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'food-log proxy failed', e, requestId: req.id });

      // If error is about default values, return a more helpful error
      if (error.message?.includes('default values') || error.message?.includes('recalculation needed')) {
        return reply.status(500).send({
          name: 'Calculation Error',
          message: 'AI did not calculate calories properly. Please try again with a clearer photo or add a description.',
          calories: 0,
          macros: { protein: 0, carbs: 0, fat: 0 },
          isFood: true,
          errorType: 'unrecognized_food',
          status: 'extra',
          matchIndex: -1,
          confidence: 0
        });
      }

      // Fallback: If we crashed, assume it's NOT a valid food analysis rather than "Extra Food"
      // This prevents "Picture of a cat" -> "Extra Food 350kcal"
      return reply.send({
        name: 'Analysis Failed',
        message: 'Could not identify food. Please try again.',
        calories: 0,
        macros: { protein: 0, carbs: 0, fat: 0 },
        isFood: false,
        errorType: 'unrecognized_food', // Trigger client side error handling if possible
        status: 'extra', // Default to extra but with 0 cals implies "didn't eat it" or "failed"
        matchIndex: -1,
        confidence: 0
      });
    }
  });

  // 5. Chat (Coach)
  const chatSchema = z.object({
    history: z.array(z.unknown()),
    context: z.enum(['nutrition', 'training']),
    lang: z.string().default('en'),
    systemPrompt: z.string().optional()
  });

  app.post('/ai/chat/coach', { preHandler: authGuard }, async (req, reply) => {
    try {
      const { history, context, lang, systemPrompt } = chatSchema.parse(req.body);

      let sys = systemPrompt;
      if (!sys) {
        if (context === 'nutrition') sys = "You are an expert Dietitian. Helpful, encouraging, scientific.";
        else sys = "You are an elite Strength Coach. Motivational, tough but fair, safety-focused.";
      }
      sys += ` Language: ${lang}. Keep responses concise.`;

      const { text: replyText } = await ai.generateChat({
        messages: history as any[],
        systemPrompt: sys,
        taskType: 'coach_chat',
      });

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      const route = aiRouter.route('coach_chat');
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'coach_chat',
        apiProvider: route.provider,
        modelVersion: route.model,
        endpoint: '/ai/chat/coach',
        requestPrompt: history.map((h: any) => h.parts?.map((p: any) => p.text).join('')).join('\n'),
        requestContext: { context, lang },
        responseRaw: { reply: replyText || 'Thinking...' }
      });

      return reply.send({ reply: replyText || 'Thinking...' });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      return reply.status(500).send({ error: isProduction ? 'Coach chat service unavailable' : (error.message || 'Coach chat failed') });
    }
  });

  // 6. Recipe Suggestions
  const recipeSchema = z.object({
    ingredients: z.string().optional(),
    imageBase64: z.string().optional(),
    lang: z.string().default('en')
  });

  app.post('/ai/recipes/suggest', { preHandler: authGuard }, async (req, reply) => {
    const startTime = Date.now();
    try {
      const { ingredients, imageBase64, lang } = recipeSchema.parse(req.body);
      const parts: any[] = [{ text: `Suggest 2 recipes based on these ingredients/fridge photo. Language: ${lang}. Return JSON array of recipes.` }];

      if (ingredients) parts.push({ text: `Ingredients: ${sanitizeUserInput(ingredients)}` });
      if (imageBase64) {
        const cleanerBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: cleanerBase64 } });
      }

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({ contents: [{ parts }] })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

      // Use robust JSON extraction
      const json = extractJsonFromResponse(text);
      if (!json) {
        req.log.error({ text: text.substring(0, 500), message: 'Failed to parse recipe suggestion response' });
        throw new Error('Failed to parse AI response');
      }

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'recipe_suggestion',
        apiProvider: 'gemini',
        modelVersion: 'gemini-3-flash-preview',
        endpoint: '/ai/recipes/suggest',
        requestPrompt: `Ingredients: ${sanitizeUserInput(ingredients || '')}`,
        requestContext: { hasImage: !!imageBase64, lang },
        responseRaw: json,
        latencyMs: Date.now() - startTime
      }).catch(() => {});

      return reply.send(json);
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      return reply.status(500).send({ error: isProduction ? 'Recipe suggestion service unavailable' : (error.message || 'Recipe suggestion failed') });
    }
  });

  // 7. Exercise Details
  const exDetailSchema = z.object({
    name: z.string(),
    lang: z.string().default('en')
  });

  app.post('/ai/exercise/details', { preHandler: authGuard }, async (req, reply) => {
    try {
      const { name, lang } = exDetailSchema.parse(req.body);
      const prompt = `Provide details for exercise: "${sanitizeUserInput(name)}". Language: ${lang}. Return JSON: { instructions: string[], safetyTips: string[], targetMuscles: string[] }. Output JSON only.`;

      const { data: parsed } = await ai.generateStructuredOutput({
        prompt,
        taskType: 'exercise_details',
      });

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      const route = aiRouter.route('exercise_details');
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'exercise_details',
        apiProvider: route.provider,
        modelVersion: route.model,
        endpoint: '/ai/exercise/details',
        requestPrompt: prompt,
        requestContext: { exerciseName: name, lang },
        responseRaw: parsed
      }).catch(() => {});

      return reply.send(parsed);
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      return reply.status(500).send({ error: isProduction ? 'Exercise details service unavailable' : (error.message || 'Exercise details failed') });
    }
  });

  // 8. Generate Image (Proxy) - Native Image Generation
  const imgProxySchema = z.object({
    prompt: z.string(),
    referenceImage: z.string().optional() // Base64 image for image-to-image consistency
  });

  app.post('/ai/generate/image', { preHandler: authGuard }, async (req, reply) => {
    const startTime = Date.now();
    try {
      const { prompt, referenceImage } = imgProxySchema.parse(req.body);

      // CORRECT MODEL: gemini-2.5-flash-image (Nano Banana)
      // Reference: https://ai.google.dev/gemini-api/docs/image-generation
      // This model natively outputs images via inlineData in response
      const model = 'gemini-2.5-flash-image';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      // Build parts array
      const parts: any[] = [];

      // Sanitize user input first, then clean for image generation
      const safePrompt = sanitizeUserInput(prompt);
      // Clean the prompt to prevent text overlays (translate to English, remove step numbers)
      const cleanedPrompt = await ai.cleanImagePrompt(safePrompt);

      // Enhanced prompt for image generation
      let enhancedPrompt = cleanedPrompt;
      if (referenceImage) {
        // Add reference image as input for style matching
        const base64Data = referenceImage.includes(',')
          ? referenceImage.split(',')[1]
          : referenceImage;
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: base64Data
          }
        });
        enhancedPrompt = `Create an image matching this reference style: ${cleanedPrompt}`;
      }

      parts.push({ text: enhancedPrompt });

      // Simple request - no responseModalities needed for this model
      const requestBody = {
        contents: [{ parts }]
      };

      req.log.info({ model, promptLength: enhancedPrompt.length }, 'Calling Gemini 2.5 Flash Image API');

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        const errorText = await res.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = null;
        }

        // Check for rate limit error
        if (res.status === 429 || errorData?.error?.message?.includes('quota')) {
          const retryDelay = errorData?.error?.details?.find((d: any) => d['@type']?.includes('RetryInfo'))?.retryDelay;
          const waitTime = retryDelay ? parseInt(retryDelay) : 60;
          throw new Error(`Rate limit exceeded. Please wait ${waitTime} seconds and try again.`);
        }

        const isProduction = process.env.NODE_ENV === 'production';
        req.log.error({ status: res.status, errorText, model }, 'Gemini Image API error');
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();

      // Response format: { candidates: [{ content: { parts: [{ inlineData: { data, mimeType } }] } }] }
      const responseParts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = responseParts.find((p: any) => p.inlineData?.data);

      if (imagePart?.inlineData?.data) {
        const mimeType = imagePart.inlineData.mimeType || 'image/png';
        req.log.info({ model, mimeType }, 'Image generated successfully');

        // Record for AI training (fire-and-forget)
        const user = (req as AuthenticatedRequest).user;
        recordApiCall({
          userId: user?.userId || 'anonymous',
          callType: 'coach_image',
          apiProvider: 'gemini',
          modelVersion: model,
          endpoint: '/ai/generate/image',
          requestPrompt: safePrompt.substring(0, 500),
          requestContext: { hasReferenceImage: !!referenceImage },
          responseRaw: { hasImage: true, mimeType },
          latencyMs: Date.now() - startTime
        }).catch(() => {});

        return reply.send({ image: `data:${mimeType};base64,${imagePart.inlineData.data}` });
      }

      // Check for text-only response (model might return text if it can't generate image)
      const textPart = responseParts.find((p: any) => p.text);
      if (textPart?.text) {
        req.log.warn({ model, textResponse: textPart.text.substring(0, 200) }, 'Model returned text instead of image');
      }

      // No image returned - log for debugging
      req.log.warn({ model, responseKeys: Object.keys(data || {}), partsCount: responseParts.length }, 'No image in Gemini response');
      return reply.send({ error: 'No image returned from AI', raw: responseParts });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);

      // Always show rate limit errors to the user
      const errorMessage = error.message || 'Image generation failed';
      const isRateLimitError = errorMessage.includes('Rate limit') || errorMessage.includes('quota');

      return reply.status(500).send({
        error: (isRateLimitError || !isProduction) ? errorMessage : 'Image generation service unavailable'
      });
    }
  });

  // Menu photo analysis - extract multiple dishes from menu photo
  app.post('/ai/menu-analysis', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    const startTime = Date.now();

    const body = z.object({
      imageBase64: z.string(),
      restaurantName: z.string().optional(),
      allergens: z.array(z.string()).default([]),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { imageBase64, restaurantName, allergens, lang } = body;

      const prompt = `
      MENU PHOTO ANALYSIS - EXTRACT ALL DISHES.
      
      You are analyzing a restaurant menu photo. Your task is to identify ALL dishes visible in the menu.
      
      Restaurant: ${restaurantName || 'Unknown'}
      User Allergens to Avoid: ${allergens.join(', ') || 'None'}
      
      Instructions:
      1. Identify EVERY dish/item visible in the menu photo
      2. For each dish, estimate:
         - Name (as written on menu or best guess)
         - Description (if visible)
         - Estimated calories (realistic range based on typical portion sizes)
         - Estimated macros (protein, carbs, fat)
         - Price (if visible)
         - Allergens (if mentioned or obvious from ingredients)
      3. Be realistic with calorie estimates - don't use default values
      4. If a dish contains user allergens, mark it clearly
      5. Return ALL dishes, not just one
      
      Return JSON array:
      [
        {
          "name": "string",
          "description": "string or null",
          "calories": number (integer, realistic estimate),
          "macros": {
            "protein": number (grams),
            "carbs": number (grams),
            "fat": number (grams)
          },
          "price": number or null,
          "allergens": ["string"],
          "hasUserAllergens": boolean,
          "confidence": number (0-100, how clear the menu item is)
        }
      ]
      
      Language: ${lang}
      `;

      const parts: any[] = [
        { text: prompt },
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')
          }
        }
      ];

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            responseSchema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  calories: { type: 'number' },
                  macros: {
                    type: 'object',
                    properties: {
                      protein: { type: 'number' },
                      carbs: { type: 'number' },
                      fat: { type: 'number' }
                    },
                    required: ['protein', 'carbs', 'fat']
                  },
                  price: { type: 'number' },
                  allergens: { type: 'array', items: { type: 'string' } },
                  hasUserAllergens: { type: 'boolean' },
                  confidence: { type: 'number' }
                },
                required: ['name', 'calories', 'macros', 'hasUserAllergens', 'confidence']
              }
            }
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

      // Use robust JSON extraction
      const parsed = extractJsonFromResponse(text);
      if (!parsed) {
        req.log.error({ error: 'Failed to parse menu analysis response', text: text.substring(0, 500), requestId: req.id });
        return reply.status(500).send({ error: 'Failed to parse AI response' });
      }

      const items = Array.isArray(parsed) ? parsed : [parsed];
      if (items.length === 0) {
        return reply.status(500).send({ error: 'Invalid response format - expected array' });
      }

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'menu_analysis',
        apiProvider: 'gemini',
        modelVersion: 'gemini-3-flash-preview',
        endpoint: '/ai/menu-analysis',
        requestPrompt: 'MENU PHOTO ANALYSIS - EXTRACT ALL DISHES',
        requestContext: { hasImage: true, restaurantName, allergenCount: allergens.length, lang },
        responseRaw: items,
        responseParsed: { itemCount: items.length },
        latencyMs: Date.now() - startTime
      }).catch(() => {});

      return reply.send(items);
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'menu-analysis failed', e, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Menu analysis failed' });
    }
  });

  // Generate step image (exercise or recipe step)
  app.post('/ai/generate/step-image', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    const startTime = Date.now();

    const body = z.object({
      type: z.enum(['exercise', 'recipe']),
      name: z.string(),
      instruction: z.string(),
      index: z.number().optional(),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { type, name, instruction, index, lang } = body;

      const safeName = sanitizeUserInput(name);
      const safeInstruction = sanitizeUserInput(instruction);
      const prompt = type === 'exercise'
        ? `Fitness photography: ${safeName} exercise, step ${index || 1}. ${safeInstruction}. Proper form, athletic model, gym setting, cinematic lighting, 8k resolution, professional quality.`
        : `Food photography: ${safeName} recipe, step ${index || 1}. ${safeInstruction}. Hyperrealistic, delicious, soft lighting, 8k resolution, professional quality.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['image', 'text'],
            responseMimeType: 'image/png'
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((p: any) => p.inlineData?.data);

      if (inline?.inlineData?.data) {
        // Record for AI training (fire-and-forget)
        const user = (req as AuthenticatedRequest).user;
        recordApiCall({
          userId: user?.userId || 'anonymous',
          callType: 'step_image_generation',
          apiProvider: 'gemini',
          modelVersion: 'gemini-2.5-flash-image',
          endpoint: '/ai/generate/step-image',
          requestPrompt: prompt,
          requestContext: { type, name: safeName, index, lang },
          responseRaw: { hasImage: true },
          latencyMs: Date.now() - startTime
        }).catch(() => {});

        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }

      return reply.status(500).send({ error: 'No image returned from AI' });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'generate step-image failed', e, requestId: req.id });
      return reply.status(500).send({ error: error.message || 'Generate step image failed' });
    }
  });

  // Generate gamification asset
  app.post('/ai/generate/gamification-asset', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    const startTime = Date.now();

    const body = z.object({
      type: z.enum(['challenge', 'badge', 'item']),
      context: z.string(),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { type, context, lang } = body;

      const safeContext = sanitizeUserInput(context);
      const prompt = type === 'challenge'
        ? `Gaming challenge icon: ${safeContext}. Bold, colorful, motivational, 8k resolution, professional game asset style.`
        : type === 'badge'
          ? `Achievement badge icon: ${safeContext}. Metallic, shiny, prestigious, 8k resolution, professional game asset style.`
          : `Game item icon: ${safeContext}. Detailed, appealing, 8k resolution, professional game asset style.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['image', 'text'],
            responseMimeType: 'image/png'
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((p: any) => p.inlineData?.data);

      if (inline?.inlineData?.data) {
        // Record for AI training (fire-and-forget)
        const user = (req as AuthenticatedRequest).user;
        recordApiCall({
          userId: user?.userId || 'anonymous',
          callType: 'gamification_asset_generation',
          apiProvider: 'gemini',
          modelVersion: 'gemini-2.5-flash-image',
          endpoint: '/ai/generate/gamification-asset',
          requestPrompt: prompt,
          requestContext: { type, context: safeContext, lang },
          responseRaw: { hasImage: true },
          latencyMs: Date.now() - startTime
        }).catch(() => {});

        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }

      return reply.status(500).send({ error: 'No image returned from AI' });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'generate gamification-asset failed', e, requestId: req.id });
      return reply.status(500).send({ error: isProduction ? 'Asset generation service unavailable' : (error.message || 'Generate gamification asset failed') });
    }
  });

  // Generate portion visual
  app.post('/ai/generate/portion-visual', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    const startTime = Date.now();

    const body = z.object({
      mealName: z.string(),
      calories: z.number(),
      type: z.enum(['large', 'small']),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { mealName, calories, type, lang } = body;

      const sizeDesc = type === 'large' ? 'large portion' : 'small portion';
      const safeMealName = sanitizeUserInput(mealName);
      const prompt = `Food photography: ${safeMealName}, ${sizeDesc}, ${calories} calories. Visual portion size comparison, hyperrealistic, professional quality, 8k resolution, soft lighting.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['image', 'text'],
            responseMimeType: 'image/png'
          }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }

      const data: any = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((p: any) => p.inlineData?.data);

      if (inline?.inlineData?.data) {
        // Record for AI training (fire-and-forget)
        const user = (req as AuthenticatedRequest).user;
        recordApiCall({
          userId: user?.userId || 'anonymous',
          callType: 'portion_visual_generation',
          apiProvider: 'gemini',
          modelVersion: 'gemini-2.5-flash-image',
          endpoint: '/ai/generate/portion-visual',
          requestPrompt: prompt,
          requestContext: { mealName: safeMealName, calories, type, lang },
          responseRaw: { hasImage: true },
          latencyMs: Date.now() - startTime
        }).catch(() => {});

        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }

      return reply.status(500).send({ error: 'No image returned from AI' });
    } catch (e: unknown) {
      const error = e as Error;
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'generate portion-visual failed', e, requestId: req.id });
      return reply.status(500).send({ error: isProduction ? 'Portion visual generation service unavailable' : (error.message || 'Generate portion visual failed') });
    }
  });

  // ========== PROOF OF SWEAT - Workout Selfie Verification ==========
  const verifyWorkoutSchema = z.object({
    imageBase64: z.string().min(100)
  });

  app.post('/ai/verify-workout', { preHandler: authGuard }, async (req, reply) => {
    const startTime = Date.now();
    const { imageBase64 } = verifyWorkoutSchema.parse(req.body);

    try {
      const mime = imageBase64.includes('png') ? 'image/png' : 'image/jpeg';
      const cleanBase64 = imageBase64.split(',')[1] || imageBase64;

      const prompt = `WORKOUT VERIFICATION TASK.

Analyze this selfie/photo to determine if the person has JUST COMPLETED A WORKOUT.

Look for these indicators:
- Gym equipment visible (dumbbells, machines, mats)
- Athletic wear (tank top, shorts, sneakers)
- Signs of exertion (sweat, flushed skin, tired expression)
- Gym environment (mirrors, lockers, outdoor trail)
- Post-workout context (water bottle, towel)

Be LENIENT but not foolish:
- Accept: Sweaty person in gym, person on running trail, home workout with mat
- Reject: Person at desk, obvious old photo, professional photoshoot

Return ONLY valid JSON:
{ "verified": boolean, "confidence": number (0-100), "notes": "string explaining what you see" }`;

      let parsed: any = null;
      const route = aiRouter.route('workout_verification');

      // Try Claude Opus first for better accuracy
      if (route.provider === 'anthropic') {
        try {
          const { text } = await claudeService.analyzeImage({
            prompt,
            imageBase64: cleanBase64,
            imageMimeType: mime as any,
            model: route.model,
            maxTokens: route.maxOutputTokens || 1024,
            temperature: 0.3,
          });
          parsed = extractJsonFromResponse(text);
        } catch (e: any) {
          logger.warn(`[ai/verify-workout] Claude failed, falling back to Gemini: ${e.message}`);
        }
      }

      // Gemini fallback
      if (!parsed) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiConfig.geminiApiKey },
          body: JSON.stringify({
            contents: [{ parts: [
              { inlineData: { mimeType: mime, data: cleanBase64 } },
              { text: prompt }
            ]}],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
          })
        });
        if (!res.ok) throw new Error(`Gemini verify-workout error ${res.status}`);
        const data: any = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        parsed = extractJsonFromResponse(text);
      }

      const result = {
        verified: parsed?.verified ?? false,
        confidence: parsed?.confidence ?? 0,
        notes: parsed?.notes ?? 'Could not analyze image'
      };

      // Record for AI training (fire-and-forget)
      const user = (req as AuthenticatedRequest).user;
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'workout_verification',
        apiProvider: route.provider,
        modelVersion: route.model,
        endpoint: '/ai/verify-workout',
        requestPrompt: 'WORKOUT VERIFICATION TASK',
        requestContext: { hasImage: true },
        responseRaw: result,
        latencyMs: Date.now() - startTime
      }).catch(() => {});

      return reply.send(result);
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'verify-workout failed', e, requestId: req.id });
      return reply.status(500).send({
        verified: false,
        confidence: 0,
        notes: error.message || 'Verification failed'
      });
    }
  });

  // Body Composition Analysis - Visual Body Fat Scanner
  const bodyCompSchema = z.object({
    imageBase64: z.string().min(100),
    gender: z.enum(['male', 'female']).optional(),
    age: z.number().optional(),
    height: z.number().optional(),
    weight: z.number().optional()
  });

  app.post('/ai/analyze-body-composition', { preHandler: authGuard }, async (req, reply) => {
    const { imageBase64, gender, age, height, weight } = bodyCompSchema.parse(req.body);

    const contextInfo = [
      gender ? `Gender: ${gender}` : null,
      age ? `Age: ${age}` : null,
      height ? `Height: ${height}cm` : null,
      weight ? `Weight: ${weight}kg` : null
    ].filter(Boolean).join(', ');

    const prompt = `You are a fitness and body composition analyst. Analyze this body photo and estimate the following metrics.

${contextInfo ? `Context: ${contextInfo}` : ''}

IMPORTANT: This is for educational and motivational purposes only. Make reasonable estimates based on visible physique characteristics.

Analyze and return a JSON object with these fields:
{
  "estimatedBodyFatPercentage": number (estimate between 5-50%),
  "confidenceLevel": "low" | "medium" | "high",
  "bodyType": "ectomorph" | "mesomorph" | "endomorph" | "combination",
  "visibleMuscleGroups": ["chest", "shoulders", "arms", "abs", "back", "legs"] (list which are visibly developed),
  "recommendations": [string] (2-3 actionable fitness tips based on current physique),
  "analysis": string (2-3 sentence analysis of the physique)
}

If the image is not a suitable body photo (clothed, face-only, unclear, or inappropriate), return:
{
  "error": true,
  "message": "descriptive reason why analysis could not be performed"
}

Return ONLY valid JSON, no markdown.`;

    try {
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      let parsed: Record<string, any> | null = null;
      const route = aiRouter.route('body_composition');

      // Try Claude Opus first for medical-grade accuracy
      if (route.provider === 'anthropic') {
        try {
          const { text: rawText } = await claudeService.analyzeImage({
            prompt,
            imageBase64: cleanBase64,
            imageMimeType: 'image/jpeg',
            model: route.model,
            maxTokens: route.maxOutputTokens || 1024,
            temperature: 0.3,
          });
          parsed = extractJsonFromResponse(rawText) as Record<string, any> | null;
        } catch (e: any) {
          logger.warn(`[ai/body-composition] Claude failed, falling back to Gemini: ${e.message}`);
        }
      }

      // Gemini fallback
      if (!parsed) {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiConfig.geminiApiKey },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } }
            ]}],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
          })
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Gemini Vision error ${res.status}: ${txt.substring(0, 200)}`);
        }
        const data: any = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        parsed = extractJsonFromResponse(rawText) as Record<string, any> | null;
      }

      if (!parsed) {
        return reply.status(400).send({ error: true, message: 'Could not parse analysis results' });
      }

      if (parsed.error) {
        return reply.status(400).send(parsed);
      }

      // Store analysis in database for tracking progress
      const user = (req as AuthenticatedRequest).user;
      await pool.query(
        `INSERT INTO body_composition_logs (user_id, estimated_bf, body_type, analysis, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [user.userId, parsed.estimatedBodyFatPercentage, parsed.bodyType, JSON.stringify(parsed)]
      ).catch(() => { /* Table may not exist, ignore */ });

      // Record for AI training (fire-and-forget)
      recordApiCall({
        userId: user?.userId || 'anonymous',
        callType: 'body_composition',
        apiProvider: route.provider,
        modelVersion: route.model,
        endpoint: '/ai/analyze-body-composition',
        requestPrompt: prompt,
        requestContext: { gender, age, height, weight },
        responseRaw: parsed,
        responseParsed: { bodyFat: parsed.estimatedBodyFatPercentage, bodyType: parsed.bodyType }
      });

      return reply.send({ success: true, ...parsed });
    } catch (e: unknown) {
      const error = e as Error;
      req.log.error({ error: 'analyze-body-composition failed', e, requestId: req.id });
      return reply.status(500).send({
        error: true,
        message: error.message || 'Body composition analysis failed'
      });
    }
  });
}
