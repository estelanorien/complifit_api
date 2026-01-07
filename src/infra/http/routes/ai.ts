
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiService } from '../../../application/services/aiService';
import { pool } from '../../db/pool';
import { authGuard } from '../hooks/auth';
import fetch from 'node-fetch';
import { aiConfig } from '../../../config/ai';

const textSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional()
});

const imageSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional()
});

const generateSchema = z.object({
  parts: z.array(z.any()),
  model: z.string().optional(),
  generationConfig: z.any().optional(),
  tools: z.any().optional()
});

const foodLogSchema = z.object({
  text: z.string().optional(),
  imageBase64: z.string().optional(),
  contextMeals: z.array(z.any()).optional(),
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

export async function aiRoutes(app: FastifyInstance) {
  const ai = new AiService();

  // Basit rate limit, uygulama geneli rate-limit varsa kaldırılabilir
  app.post('/ai/text', { preHandler: authGuard }, async (req, reply) => {
    const parsed = textSchema.parse(req.body);
    const result = await ai.generateText(parsed);
    return reply.send(result);
  });

  app.post('/ai/image', { preHandler: authGuard }, async (req, reply) => {
    const parsed = imageSchema.parse(req.body);
    const result = await ai.generateImage(parsed);
    return reply.send(result);
  });

  // General Gemini proxy (server-side key)
  app.post('/ai/generate-content', { preHandler: authGuard }, async (req, reply) => {
    const body = generateSchema.parse(req.body || {});
    const { parts, model = 'models/gemini-2.5-flash', generationConfig, tools } = body;

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
      return reply.send({ text: firstText, parts: contentParts });
    } catch (e: any) {
      req.log.error({ error: 'generate-content proxy failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'generate failed' });
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

    const mealContext = contextMeals
      .map((m: any, i: number) => `${i}: ${m?.recipe?.name || m?.recipe?.title || 'meal'} (${m?.recipe?.calories ?? 'unk'} kcal)`)
      .join(', ');

    // Build prompt based on whether we have image or text
    let prompt = '';
    const parts: any[] = [];

    if (imageBase64) {
      // IMAGE-FIRST ANALYSIS: Prioritize visual recognition and detect NON-FOOD images
      prompt = `
      FOOD IMAGE ANALYSIS - CRITICAL TASK.
      
      You are an expert nutritionist and food recognition AI, specializing in both GLOBAL and TURKISH CUISINE.
      Analyze the FOOD PHOTO provided.
      
      STEP 0: CONTEXT CHECK
      - You are analysing a photo for a fitness/nutrition app.
      - If the image contains food, drink, or supplements, proceed to analyze it.
      - If the image contains absolutely NO food (e.g. just a face, a landscape, a document), set "isFood" = false.
      - Be lenient: messy plates, packed food, and restaurant menus are acceptable context.

      STEP 1: VISUAL PORTION ANALYSIS (CRITICAL - BE PRECISE)
      - CAREFULLY examine the image. Analyze the ACTUAL VISIBLE AMOUNT of food, not just the dish type.
      - Estimate portion size using visual references:
        * Compare food size to common objects (e.g., deck of cards = 85g meat, tennis ball = 1 cup rice, thumb = 1 tbsp oil)
        * Estimate plate/bowl diameter: Small plate (18-20cm) vs Large plate (25-30cm) vs Extra large (30cm+)
        * Visual volume estimation: Is the plate 1/4 full, 1/2 full, 3/4 full, or overflowing?
        * Count individual items: How many pieces of bread? How many meatballs? How many slices?
      - Identify EVERY dish present with SPECIFIC AMOUNTS:
        * Main protein: Estimate weight in grams (e.g., "150g grilled chicken breast" not just "chicken")
        * Carbohydrates: Estimate volume (e.g., "1.5 cups rice" or "200g pasta")
        * Vegetables: Estimate volume (e.g., "2 cups mixed salad" or "1 cup roasted vegetables")
        * Fats/Oils: Visible oil, butter, sauces (e.g., "2 tbsp olive oil" or "heavy cream sauce")
        * Bread/Sides: Count pieces and estimate size (e.g., "2 pieces pide" or "1 large simit")
      - For Turkish dishes, identify SPECIFIC AMOUNTS:
        * Döner: Estimate thickness and width (e.g., "200g döner" = ~450 kcal, "150g" = ~340 kcal)
        * Lahmacun: Count pieces and estimate size (e.g., "1 large lahmacun" = ~280 kcal, "1 small" = ~200 kcal)
        * Pide: Estimate size (e.g., "1/2 pide" = ~250 kcal, "full pide" = ~500 kcal)
        * Köfte: Count pieces and estimate size (e.g., "4 medium köfte" = ~320 kcal, "6 small" = ~240 kcal)
        * Börek: Count pieces and type (e.g., "2 cheese börek" = ~500 kcal, "1 meat börek" = ~350 kcal)
        * Çorba: Estimate bowl size (e.g., "1 large bowl mercimek çorbası" = ~250 kcal, "1 small" = ~150 kcal)
        * Baklava: Count pieces and estimate size (e.g., "2 pieces baklava" = ~400 kcal, "1 piece" = ~200 kcal)
      
      STEP 2: DETAILED CALORIE CALCULATION (SCIENTIFIC & ACCURATE)
      - ⚠️ CRITICAL: You MUST calculate calories based on ACTUAL VISUAL PORTION ESTIMATION.
      - ⚠️ NEVER return default values like 350 calories, 20g protein, 35g carbs, 12g fat.
      - ⚠️ If you return 350/20/35/12, your response will be REJECTED.
      - Calculate calories using STANDARD NUTRITION DATABASES and visual portion estimates.
      - Use these caloric densities per 100g (adjust based on VISUAL WEIGHT):
        * Lean proteins (grilled chicken, fish): 150-200 kcal/100g
        * Fatty proteins (döner, köfte with oil): 250-350 kcal/100g
        * Fried proteins: 300-400 kcal/100g
        * Rice/Pilav: 130-150 kcal/100g (cooked)
        * Pasta: 130-150 kcal/100g (cooked)
        * Bread: 250-300 kcal/100g
        * Vegetables (raw): 20-50 kcal/100g
        * Vegetables (cooked with oil): 100-200 kcal/100g
        * Olive oil/Butter: 900 kcal/100g (1 tbsp = ~120 kcal)
        * Cheese: 300-400 kcal/100g
        * Nuts: 600-700 kcal/100g
      - Calculate macros based on portion size:
        * Protein: 4 kcal per gram
        * Carbs: 4 kcal per gram
        * Fat: 9 kcal per gram
      - IMPORTANT: Sum ALL components separately:
        * Main dish calories + Side dish calories + Sauce calories + Bread calories + Drink calories = TOTAL
      - Be REALISTIC: A typical restaurant meal with protein, carbs, vegetables, and sauce is usually 600-1000 kcal.
      - For Turkish restaurant meals, typical ranges:
        * Simple meal (1 main + bread): 500-700 kcal
        * Standard meal (main + rice + salad + bread): 700-900 kcal
        * Large meal (main + multiple sides + bread + drink): 900-1200 kcal
        * Fast food style (döner wrap, lahmacun with ayran): 600-800 kcal
      
      STEP 3: MATCHING (CRITICAL - BE SMART AND LENIENT)
      - Planned meals: [${mealContext}].
      - Your goal is to MATCH the photo to a planned meal if possible.
      - Be VERY LENIENT and SMART in matching:
        * "Grilled Chicken" matches "Chicken Breast", "Tavuk", "Izgara Tavuk"
        * "Pasta" matches "Spaghetti", "Makarna", "Penne"
        * "Rice" matches "Pilav", "White Rice", "Brown Rice"
        * "Salad" matches "Salata", "Green Salad", "Mixed Salad"
        * "Soup" matches "Çorba", "Soup", "Mercimek Çorbası"
      - If the main ingredients overlap (even partially), consider it a MATCH.
      - Consider Turkish-English translations: "Tavuk" = "Chicken", "Et" = "Meat", "Balık" = "Fish", etc.
      - If matched, set "status" = "matched" and "matchIndex" = index of the meal (0-based).
      - If clearly different (e.g. photo is Pizza, plan is Salad), set "status" = "extra".
      
      STEP 4: UNRECOGNIZED / ERROR HANDLING
      - If the image is food but too blurry/dark/unclear to identify:
        * Set "isFood" = false, "errorType" = "unrecognized_food".
        * Set calories = 0, macros = {protein: 0, carbs: 0, fat: 0}
        * Set confidence = 0
      - If the image contains NO food at all (face, landscape, document, etc.):
        * Set "isFood" = false, "errorType" = "not_food".
        * Set calories = 0, macros = {protein: 0, carbs: 0, fat: 0}
        * Set confidence = 0
      - If you CAN identify the food, set "isFood" = true, "errorType" = "ok", and provide your best estimate with confidence score (0-100).
      
      CALCULATION EXAMPLE:
      If you see a plate with:
      - 200g grilled chicken breast (200g × 1.65 kcal/g = 330 kcal, 60g protein, 4g fat, 0g carbs)
      - 150g rice pilav (150g × 1.4 kcal/g = 210 kcal, 4g protein, 0.5g fat, 45g carbs)
      - 100g roasted vegetables with oil (100g × 1.5 kcal/g = 150 kcal, 2g protein, 8g fat, 15g carbs)
      - 1 piece bread (50g × 2.7 kcal/g = 135 kcal, 4g protein, 1g fat, 25g carbs)
      TOTAL: 825 kcal, 70g protein, 13.5g fat, 85g carbs
      
      RETURN JSON EXACTLY:
      {
          "name": "string (food name with portion details, e.g. 'Grilled Chicken with Rice and Vegetables')",
          "calories": number (integer, MUST be realistic based on visual portion. NEVER use 350 as default!),
          "macros": { 
              "protein": number (grams, must match calories: protein × 4 + carbs × 4 + fat × 9 ≈ calories),
              "carbs": number (grams),
              "fat": number (grams)
          },
          "status": "matched" | "extra",
          "matchIndex": number,
          "confidence": number (0-100, higher if portion is clear, lower if uncertain),
          "isFood": boolean,
          "errorType": "ok" | "not_food" | "unrecognized_food",
          "message": "Short feedback string describing what you see and estimated portion (e.g. '200g grilled chicken with 1.5 cups rice and mixed vegetables, estimated 850 kcal')"
      }
      
      CRITICAL: Do NOT use generic/sablon values. Calculate based on ACTUAL VISUAL ESTIMATION of portion sizes.
      Start.`;

      // Add image first, then text context if any, then prompt
      const mime = imageBase64.includes('png') ? 'image/png' : 'image/jpeg';
      parts.push({ inlineData: { mimeType: mime, data: imageBase64.split(',')[1] } });
      if (text && text.trim()) {
        parts.push({ text: `User context/description: "${text}"` });
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
      parts.push({ text: `User Log: "${text}"` });
      parts.push({ text: prompt });
    }

    const model = 'models/gemini-2.5-flash';

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
            requestId: (req as any).requestId,
            hasCalories,
            hasMacros,
            message: '❌ ensureDefaults: AI did not provide required values!'
          });
          req.log.error({ 
            requestId: (req as any).requestId,
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
              req.log.error({ error: '🚨 Cached response has default values - ignoring cache and recalculating', requestId: (req as any).requestId });
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
              req.log.error({ error: '🚨 Cached response has default values - ignoring cache and recalculating', requestId: (req as any).requestId });
              // Don't return cached - let it fall through to AI call
            } else {
              return reply.send(ensureDefaults(cachedResp));
            }
          }
        }
      } catch (e) {
        req.log.warn({ error: e, requestId: (req as any).requestId, message: 'food-log cache lookup failed' });
      }

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts }],
          systemInstruction: {
            parts: [{
              text: `You are an expert nutritionist and food recognition AI. Your task is to analyze food images and text with EXTREME ACCURACY in calorie and macro estimation.

CRITICAL CALORIE CALCULATION RULES:
1. ⚠️ NEVER use generic or default values like 350 calories, 20g protein, 35g carbs, 12g fat.
2. ⚠️ If you return 350/20/35/12, your response will be REJECTED and you will be asked to recalculate.
3. Always calculate based on ACTUAL VISUAL ESTIMATION or SPECIFIC QUANTITY mentioned.
2. For images: Estimate portion size visually using reference objects (deck of cards, tennis ball, thumb, plate size).
3. For text: Parse exact quantities (grams, portions, pieces) and calculate accordingly.
4. Use standard caloric densities per 100g:
   - Lean proteins: 150-200 kcal/100g
   - Fatty proteins: 250-350 kcal/100g
   - Fried foods: base + 50-100 kcal/100g
   - Rice/Pasta (cooked): 130-150 kcal/100g
   - Bread: 250-300 kcal/100g
   - Vegetables (raw): 20-50 kcal/100g
   - Vegetables (cooked with oil): 100-200 kcal/100g
   - Oils: 900 kcal/100g (1 tbsp ≈ 120 kcal)
5. Calculate macros: protein × 4 + carbs × 4 + fat × 9 ≈ total calories (±10% tolerance).
6. Sum ALL components: main dish + sides + sauces + bread + drinks = TOTAL calories.
7. Be REALISTIC: A typical restaurant meal is 600-1000 kcal, not 200-300 kcal.

Your responses must be ACCURATE, REALISTIC, and based on ACTUAL PORTION ESTIMATION, not generic templates.`
            }]
          },
          // enforce JSON schema
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3, // Lower temperature for more consistent, accurate calculations
            responseSchema: {
              type: 'object',
              required: ['name', 'calories', 'macros', 'status', 'matchIndex', 'confidence', 'isFood', 'errorType', 'message'],
              properties: {
                name: { type: 'string' },
                calories: { 
                  type: 'number',
                  description: 'Total calories calculated based on visual portion estimation. MUST be realistic (typically 200-1200 for meals).'
                },
                macros: {
                  type: 'object',
                  required: ['protein', 'carbs', 'fat'],
                  properties: {
                    protein: { 
                      type: 'number',
                      description: 'Protein in grams. Must satisfy: protein × 4 + carbs × 4 + fat × 9 ≈ calories'
                    },
                    carbs: { 
                      type: 'number',
                      description: 'Carbohydrates in grams'
                    },
                    fat: { 
                      type: 'number',
                      description: 'Fat in grams'
                    }
                  }
              },
                status: { 
                  type: 'string',
                  enum: ['matched', 'extra'],
                  description: 'matched if food matches a planned meal, extra otherwise'
                },
                matchIndex: { 
                  type: 'number',
                  description: 'Index of matched meal (0-based) if status is matched, else -1'
                },
                confidence: { 
                  type: 'number',
                  description: 'Confidence score 0-100 based on how clear the portion size is'
                },
                isFood: { 
                  type: 'boolean',
                  description: 'true if image contains food, false otherwise'
                },
                errorType: { 
                  type: 'string',
                  enum: ['ok', 'not_food', 'unrecognized_food'],
                  description: 'ok if food identified, not_food if no food in image, unrecognized_food if too blurry'
                },
                message: { 
                  type: 'string',
                  description: 'Description of what was identified and estimated portion (e.g. "200g grilled chicken with 1.5 cups rice, estimated 850 kcal")'
                }
              }
            }
          }
        })
      });
      if (!res.ok) {
        const txt = await res.text();
        req.log.error({ 
          requestId: (req as any).requestId,
          status: res.status,
          responseText: txt,
          message: 'food-log proxy: non-200'
        });
        throw new Error(`Gemini food-log error ${res.status}: ${txt}`);
      }
      const data: any = await res.json();
      // Find first parsable text part
      const responseParts: any[] = data?.candidates?.[0]?.content?.parts || [];
      // Improved JSON extraction
      const findAllJson = (str: string) => {
        const jsonPattern = /\{(?:[^{}]|([^{}]|)*)*\}/g;
        // Simple brace matching might be enough for flat JSON or single object
        // But for nested, a recursive parser or reliable regex is hard.
        // Let's rely on finding the first '{' and the last '}'
        const firstOpen = str.indexOf('{');
        const lastClose = str.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose > firstOpen) {
          return str.substring(firstOpen, lastClose + 1);
        }
        return null;
      };

      let parsed: any = null;
      for (const p of responseParts) {
        const candidateText = p?.text;
        if (!candidateText) continue;
        try {
          let cleaned = candidateText.trim();
          // Remove markdown blocks
          cleaned = cleaned.replace(/```json/g, '').replace(/```/g, '');

          // Try parsing the whole thing first
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            // If failed, try extracting JSON substring
            const extracted = findAllJson(cleaned);
            if (extracted) {
              parsed = JSON.parse(extracted);
            }
          }

          if (parsed) break;
        } catch (e) {
          continue;
        }
      }

      if (!parsed) {
        req.log.warn({ responseParts: JSON.stringify(responseParts).slice(0, 1000), message: 'food-log proxy: could not parse candidate parts' });
        // If Gemini refused (e.g. safety), it might return text. Treat as "Not Food" / Error.
        const refusalText = responseParts.map(p => p.text).join(' ');
        if (refusalText.toLowerCase().includes("cannot") || refusalText.toLowerCase().includes("safety")) {
          return reply.send({
            isFood: false,
            errorType: 'not_food',
            message: 'Image could not be processed (Safety/Policy).',
            name: 'Invalid Image',
            calories: 0,
            macros: { protein: 0, carbs: 0, fat: 0 },
            status: 'extra',
            matchIndex: -1,
            confidence: 0
          });
        }
        throw new Error("JSON parsing failed");
      }

      // CRITICAL: Check if AI returned default values (this check MUST happen BEFORE ensureDefaults)
      req.log.info({ parsed, message: '=== CHECKING AI RESPONSE ===' });
      
      const isDefaultValues = parsed?.calories === 350 && 
                              parsed?.macros?.protein === 20 && 
                              parsed?.macros?.carbs === 35 && 
                              parsed?.macros?.fat === 12;
      
      if (isDefaultValues) {
        req.log.error({ 
          requestId: (req as any).requestId,
          parsed,
          message: '🚨🚨🚨 CRITICAL: AI returned default values (350/20/35/12)!'
        });
        req.log.error({ 
          requestId: (req as any).requestId,
          message: 'AI did NOT calculate - rejecting response!'
        });
        req.log.error({ 
          requestId: (req as any).requestId,
          response: JSON.stringify(parsed, null, 2),
          message: 'Full response'
        });
        throw new Error("AI returned default values (350/20/35/12) - recalculation needed");
      }
      
      // If we get here, AI provided non-default values - proceed with ensureDefaults
      const finalResp = ensureDefaults(parsed);
      req.log.info({ 
        requestId: (req as any).requestId,
        calories: finalResp.calories, 
        macros: finalResp.macros,
        message: '✅ AI provided calculated values'
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
        req.log.warn({ error: e, requestId: (req as any).requestId, message: 'food-log cache save failed' });
      }

      return reply.send(finalResp);
    } catch (e: any) {
      req.log.error({ error: 'food-log proxy failed', e, requestId: (req as any).requestId });
      
      // If error is about default values, return a more helpful error
      if (e.message?.includes('default values') || e.message?.includes('recalculation needed')) {
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
    history: z.array(z.any()),
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

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: history,
          systemInstruction: { parts: [{ text: sys }] }
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();
      const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Thinking...";

      return reply.send({ reply: replyText });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      return reply.status(500).send({ error: isProduction ? 'Coach chat service unavailable' : (e.message || 'Coach chat failed') });
    }
  });

  // 6. Recipe Suggestions
  const recipeSchema = z.object({
    ingredients: z.string().optional(),
    imageBase64: z.string().optional(),
    lang: z.string().default('en')
  });

  app.post('/ai/recipes/suggest', { preHandler: authGuard }, async (req, reply) => {
    try {
      const { ingredients, imageBase64, lang } = recipeSchema.parse(req.body);
      const parts: any[] = [{ text: `Suggest 2 recipes based on these ingredients/fridge photo. Language: ${lang}. Return JSON array of recipes.` }];

      if (ingredients) parts.push({ text: `Ingredients: ${ingredients}` });
      if (imageBase64) {
        const cleanerBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: cleanerBase64 } });
      }

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
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

      // Clean JSON
      let cleaned = text.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
      const json = JSON.parse(cleaned);
      return reply.send(json);
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      return reply.status(500).send({ error: isProduction ? 'Recipe suggestion service unavailable' : (e.message || 'Recipe suggestion failed') });
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
      const prompt = `Provide details for exercise: "${name}". Language: ${lang}. Return JSON: { instructions: string[], safetyTips: string[], targetMuscles: string[] }. Output JSON only.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (!res.ok) {
        const errorText = await res.text();
        const isProduction = process.env.NODE_ENV === 'production';
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

      let cleaned = text.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
      return reply.send(JSON.parse(cleaned));
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      return reply.status(500).send({ error: isProduction ? 'Exercise details service unavailable' : (e.message || 'Exercise details failed') });
    }
  });

  // 8. Generate Image (Proxy)
  const imgProxySchema = z.object({
    prompt: z.string()
  });

  app.post('/ai/generate/image', { preHandler: authGuard }, async (req, reply) => {
    try {
      const { prompt } = imgProxySchema.parse(req.body);
      // Use gemini-2.5-flash-image for image generation
      const model = 'models/gemini-2.5-flash-image';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`, {
        method: 'POST',
        headers: {  
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
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
        throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini error ${res.status}: ${errorText}`);
      }
      const data: any = await res.json();

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((p: any) => p.inlineData?.data);
      if (inline?.inlineData?.data) {
        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }
      return reply.send({ error: 'No image returned', raw: parts });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error(e);
      
      // Always show rate limit errors to the user
      const errorMessage = e.message || 'Image generation failed';
      const isRateLimitError = errorMessage.includes('Rate limit') || errorMessage.includes('quota');
      
      return reply.status(500).send({ 
        error: (isRateLimitError || !isProduction) ? errorMessage : 'Image generation service unavailable' 
      });
    }
  });

  // Menu photo analysis - extract multiple dishes from menu photo
  app.post('/ai/menu-analysis', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    
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

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
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
      
      let items: any[] = [];
      try {
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        items = JSON.parse(cleaned);
      } catch (e) {
        req.log.error({ error: 'Failed to parse menu analysis response', e, requestId: (req as any).requestId });
        return reply.status(500).send({ error: 'Failed to parse AI response' });
      }

      if (!Array.isArray(items)) {
        return reply.status(500).send({ error: 'Invalid response format - expected array' });
      }

      return reply.send(items);
    } catch (e: any) {
      req.log.error({ error: 'menu-analysis failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Menu analysis failed' });
    }
  });

  // Generate step image (exercise or recipe step)
  app.post('/ai/generate/step-image', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    
    const body = z.object({
      type: z.enum(['exercise', 'recipe']),
      name: z.string(),
      instruction: z.string(),
      index: z.number().optional(),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { type, name, instruction, index, lang } = body;
      
      const prompt = type === 'exercise'
        ? `Fitness photography: ${name} exercise, step ${index || 1}. ${instruction}. Proper form, athletic model, gym setting, cinematic lighting, 8k resolution, professional quality.`
        : `Food photography: ${name} recipe, step ${index || 1}. ${instruction}. Hyperrealistic, delicious, soft lighting, 8k resolution, professional quality.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }] })
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
        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }
      
      return reply.status(500).send({ error: 'No image returned from AI' });
    } catch (e: any) {
      req.log.error({ error: 'generate step-image failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: e.message || 'Generate step image failed' });
    }
  });

  // Generate gamification asset
  app.post('/ai/generate/gamification-asset', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    
    const body = z.object({
      type: z.enum(['challenge', 'badge', 'item']),
      context: z.string(),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { type, context, lang } = body;
      
      const prompt = type === 'challenge'
        ? `Gaming challenge icon: ${context}. Bold, colorful, motivational, 8k resolution, professional game asset style.`
        : type === 'badge'
        ? `Achievement badge icon: ${context}. Metallic, shiny, prestigious, 8k resolution, professional game asset style.`
        : `Game item icon: ${context}. Detailed, appealing, 8k resolution, professional game asset style.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
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
        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }
      
      return reply.status(500).send({ error: 'No image returned from AI' });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'generate gamification-asset failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: isProduction ? 'Asset generation service unavailable' : (e.message || 'Generate gamification asset failed') });
    }
  });

  // Generate portion visual
  app.post('/ai/generate/portion-visual', { preHandler: authGuard }, async (req, reply) => {
    if (!aiConfig.geminiApiKey) return reply.status(500).send({ error: 'GEMINI_API_KEY missing' });
    
    const body = z.object({
      mealName: z.string(),
      calories: z.number(),
      type: z.enum(['large', 'small']),
      lang: z.string().default('en')
    }).parse(req.body);

    try {
      const { mealName, calories, type, lang } = body;
      
      const sizeDesc = type === 'large' ? 'large portion' : 'small portion';
      const prompt = `Food photography: ${mealName}, ${sizeDesc}, ${calories} calories. Visual portion size comparison, hyperrealistic, professional quality, 8k resolution, soft lighting.`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': aiConfig.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
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
        return reply.send({ image: `data:image/png;base64,${inline.inlineData.data}` });
      }
      
      return reply.status(500).send({ error: 'No image returned from AI' });
    } catch (e: any) {
      const isProduction = process.env.NODE_ENV === 'production';
      req.log.error({ error: 'generate portion-visual failed', e, requestId: (req as any).requestId });
      return reply.status(500).send({ error: isProduction ? 'Portion visual generation service unavailable' : (e.message || 'Generate portion visual failed') });
    }
  });
}
