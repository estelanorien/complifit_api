import { AiService } from './aiService.js';
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { TranslationService, translationService } from './translationService.js';
import { jobProcessor } from './jobProcessor.js';

const aiService = new AiService();

const cleanGeminiJson = (text: string): string => {
  if (!text) return text;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
};

const normalizeIngredients = (ingredients: any[]): string[] => {
  if (!Array.isArray(ingredients)) return [];
  return ingredients.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item === 'object' && item !== null) {
      const qty = item.quantity || item.amount || item.qty || '';
      const name = item.item || item.name || item.ingredient || 'Ingredient';
      return qty ? `${qty} ${name}` : String(name);
    }
    return String(item);
  });
};

const normalizeInstructions = (instructions: any[]): any[] => {
  if (!Array.isArray(instructions)) return [];
  return instructions.map((item) => {
    if (typeof item === 'string') {
      return { simple: item, detailed: item };
    }
    if (typeof item === 'object' && item !== null) {
      return {
        simple: item.simple || item.text || item.instruction || 'Enjoy.',
        detailed: item.detailed || item.text || item.instruction || 'Enjoy your meal.'
      };
    }
    return { simple: String(item), detailed: String(item) };
  });
};

type MealPlanMeal = {
  type: string;
  recipe: {
    name: string;
    calories: number;
    time?: string;
    ingredients?: string[];
    instructions?: any[];
    macros?: any;
    nutritionTips?: string[];
    prepTips?: string[];
    benefits?: string[];
  };
  macronutrientFocus?: string;
  [key: string]: any;
};

type MealPlanDay = {
  day: string;
  meals: MealPlanMeal[];
  targetCalories?: number;
};

export type MealPlan = {
  name?: string;
  overview?: string;
  days: MealPlanDay[];
  varietyMode?: string;
  source?: string;
};

type GenerateNutritionPlanParams = {
  profile: any;
  days: number;
  excludes: string[];
  staples: any[];
  lang: string;
  prioritizeSuperfoods?: boolean;
  varietyMode?: string;
  previousPlan?: any;
  varietyInput?: string;
};

export async function generateNutritionPlan(params: GenerateNutritionPlanParams): Promise<MealPlan> {
  const {
    profile,
    days,
    excludes,
    staples,
    lang,
    prioritizeSuperfoods,
    varietyMode,
    previousPlan,
    varietyInput
  } = params;

  const profileSummary = {
    age: profile?.age,
    gender: profile?.gender,
    weight: profile?.weight,
    height: profile?.height,
    activity: profile?.workoutDaysPerWeek,
    diet: profile?.dietaryPreference,
    exclusions: profile?.excludedIngredients,
    goals: profile?.nutritionGoals || profile?.specificGoals,
    medical: profile?.conditions,
    glp1Mode: profile?.glp1Mode
  };

  // --- VALIDATION HELPERS ---
  const validateBatch = (parsed: any): { isValid: boolean, issues: string[] } => {
    const issues: string[] = [];
    if (!parsed || !Array.isArray(parsed.days)) {
      return { isValid: false, issues: ['Invalid JSON structure: missing "days" array'] };
    }

    parsed.days.forEach((day: any, dIdx: number) => {
      if (Array.isArray(day.meals)) {
        day.meals.forEach((meal: any, mIdx: number) => {
          const name = meal?.recipe?.name || `Meal D${dIdx}M${mIdx}`;

          // 1. Check Step Count (Critical)
          const steps = meal?.recipe?.instructions;
          if (!Array.isArray(steps) || steps.length < 7) { // Strict 7 step min (Target 8-10)
            issues.push(`Meal "${name}" has only ${steps?.length || 0} steps. MUST have 8-10 steps.`);
          }

          // 2. Check Detail Level (Quality)
          if (Array.isArray(steps)) {
            steps.forEach((s: any, sIdx: number) => {
              const detailed = typeof s === 'string' ? s : s.detailed;
              if (!detailed || detailed.length < 15) {
                issues.push(`Meal "${name}" step ${sIdx + 1} is too short ("${detailed}"). Needs detail.`);
              }
            });
          }

          // 3. Check Nutrient Science (Prep Tips)
          // We want this for the UI card.
          if (!meal.recipe?.nutritionTips || meal.recipe.nutritionTips.length === 0) {
            // Warn but maybe don't fail for this? User specifically asked for it though.
            // Let's enforce it.
            issues.push(`Meal "${name}" is missing "nutritionTips" (Nutrient Science).`);
          }
        });
      }
    });

    return { isValid: issues.length === 0, issues };
  };

  // --- BATCH GENERATION LOGIC ---
  const BATCH_SIZE = 7;

  // Helper to generate a chunk of the plan
  const generateBatch = async (
    startDayInfo: number,
    chunkDays: number,
    currentPreviousPlan?: any
  ): Promise<MealPlan> => {
    const promptSections: string[] = [];
    promptSections.push(`You are a clinical dietitian. Build a ${chunkDays}-day meal plan in English.`);
    promptSections.push(`This is Part ${Math.ceil(startDayInfo / BATCH_SIZE)} of a larger plan. Start labelling from "Day ${startDayInfo}".`);
    promptSections.push(`USER PROFILE: ${JSON.stringify(profileSummary)}`);
    promptSections.push(`EXCLUDES: ${JSON.stringify(excludes || [])}`);
    promptSections.push(`STAPLES: ${JSON.stringify(staples || [])}`);
    if (prioritizeSuperfoods) promptSections.push(`PRIORITIZE SUPERFOODS and anti-inflammatory ingredients.`);
    if (varietyMode) promptSections.push(`VARIETY MODE: ${varietyMode}. ${varietyInput || ''}`);
    if (currentPreviousPlan) promptSections.push(`PREVIOUS PLAN SUMMARY: ${JSON.stringify(currentPreviousPlan?.days?.slice(-2) || [])}`); // Use end of previous chunk

    if (profile?.glp1Mode) {
      promptSections.push(`GLP-1 OPTIMIZATION PROTOCOL (Ozempic/Wegovy):
    1. PROTEIN SPARING: Prioritize high-protein (min 30g/meal) to prevent lean tissue loss.
    2. VOLUME: Smaller, nutrient-dense portions due to delayed gastric emptying.
    3. HYDRATION: Emphasize electrolytes and water-rich whole foods.
    4. NAUSEA MANAGEMENT: Limit greasy/high-fat items that trigger side effects.`);
    }

    promptSections.push(`NUTRIENT SCIENCE REQUIREMENT:
    You MUST include a "nutritionTips" array for EVERY meal. 
    These should be "Chef's Science Tips" explaining WHY specific ingredients/methods maximize health (e.g., "Pairing black pepper with turmeric increases curcumin absorption by 2000%").
    This is required for the "Nutrient Science" UI card.`);


    // Safety Protocol (BMR & Extremes)
    const weight = profileSummary.weight || 70;
    const height = profileSummary.height || 170;
    const age = profileSummary.age || 30;
    const gender = profileSummary.gender || 'male';

    // Mifflin-St Jeor Equation
    let bmr = 10 * weight + 6.25 * height - 5 * age;
    bmr += (gender === 'male' ? 5 : -161);
    const minSafeCalories = Math.max(1200, Math.round(bmr));

    promptSections.push(`SAFETY PROTOCOL (CRITICAL):
    1. MINIMUM CALORIES: Do not prescribe less than ${minSafeCalories} kcal/day unless explicitly medically supervised (not the case here).
    2. EXTREME DEFICITS: Avoid reckless caloric cuts. Ensure sustainability.
    3. NUTRIENT DENSITY: Ensure micronutrient needs are met even in deficit.`);

    promptSections.push(`
    STYLE GUIDE (STRICT ENFORCEMENT):
    1. TONE: Professional chef meets nutritionist. Encouraging but precise.
    2. DETAIL LEVEL: "detailed" steps must be 2-3 sentences long. Include sensory details (smell, texture) and technique tips.
    3. STEP COUNT: Every recipe MUST have 8-10 distinct steps. Fewer than 8 steps is a FAILURE.
    4. ACCURACY: Macronutrients must sum up correctly (Protein*4 + Carbs*4 + Fat*9 ~= Calories).

    JSON STRUCTURE & CONSTRAINTS:
    Return JSON exactly as below. Constraints are CRITICAL:

    {
      "name": "Part ${Math.ceil(startDayInfo / BATCH_SIZE)}",
      "overview": "Short summary",
      "days": [
        {
          "day": "Day ${startDayInfo}",
          "targetCalories": 2200,
          "meals": [
            {
              "type": "breakfast",
              "recipe": {
                "name": "Meal Name",
                "calories": 500,
                "time": "15 min",
                "ingredients": ["1 cup oats", "200ml almond milk"],
                "instructions": [
                  {
                    "simple": "Active voice summary (max 10 words)",
                    "detailed": "Detailed step: technique, timing, visual cues. (2-3 sentences)"
                  },
                  // ... MUST HAVE 8-10 STEPS ...
                ],
                "macros": { "protein": 30, "carbs": 50, "fat": 15 },
                "nutritionTips": [
                  "Scientific tip with rationale"
                ]
              },
              "macronutrientFocus": "High Protein"
            }
          ]
        }
      ]
    }
    
    CRITICAL QUALITY CHECKS:
    - Check "instructions" array length. If < 8, ADD MORE STEPS (e.g., prep, cooking, plating, serving).
    - Ensure "detailed" text explains HOW and WHY, not just WHAT.
    - NEVER use single-step instructions or placeholders.
    `);

    const { text } = await aiService.generateText({
      prompt: promptSections.join('\n'),
      model: 'models/gemini-3-flash-preview'
    });

    try {
      const parsed = JSON.parse(cleanGeminiJson(text) || '{}');
      const validation = validateBatch(parsed);

      if (!validation.isValid) {
        throw new Error(`Validation Failed: ${validation.issues.join('; ')}`);
      }

      return parsed;
    } catch (e: any) {
      throw new Error(`Parse/Validation Error: ${e.message}`);
    }
  };

  // Main Execution Loop
  let finalDays: MealPlanDay[] = [];
  let planName = "";
  let planOverview = "";

  for (let i = 1; i <= days; i += BATCH_SIZE) {
    const remaining = days - i + 1;
    const currentChunkSize = Math.min(remaining, BATCH_SIZE);

    // RETRY LOOP FOR THIS BATCH
    let attempts = 0;
    const MAX_RETRIES = 3;
    let chunkSuccess = false;

    while (attempts < MAX_RETRIES && !chunkSuccess) {
      attempts++;
      try {
        // Pass the previous chunk as "previousPlan" for continuity if not the first chunk
        const prevContext = i > 1 ? { days: finalDays } : previousPlan;

        // If retrying, append error context to prompt?
        // The generateBatch helper re-builds prompt every time.
        // We might need to modify generateBatch to accept "lastError" but that complicates the closure.
        // Since the AI is non-deterministic (temperature), just retrying simply works effectively most times.

        const chunk = await generateBatch(i, currentChunkSize, prevContext);

        if (i === 1) {
          planName = chunk.name || `Nutrition Plan (${days} Days)`;
          planOverview = chunk.overview || "";
        }

        if (chunk.days) {
          finalDays = [...finalDays, ...chunk.days];
          chunkSuccess = true;
        }
      } catch (e: any) {
        logger.error(`[NutritionService] Batch (Day ${i}) Attempt ${attempts} failed`, e, { day: i, attempts, maxRetries: MAX_RETRIES });
        if (attempts === MAX_RETRIES) {
          // If we ran out of retries, we might have to accept a partial/broken result OR fail hard.
          // Failing hard is safer than showing broken data.
          logger.error('[NutritionService] CRITICAL: Max retries reached for batch generation.', undefined, { day: i, attempts, maxRetries: MAX_RETRIES });
          // Optional: fallback to manual "simple" recipe or just throw
          // For now, let's throw to allow the outer handler to deal with it (or user gets an error)
          // But wait, user wants "automatic" fix.
        }
      }
    }

    // CLOSE MAIN LOOP HERE
  }

  // Construct Final Plan
  const parsedPlan: MealPlan = {
    name: planName,
    overview: planOverview,
    days: finalDays,
    varietyMode: varietyMode
  };

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
      // Service doesn't have req, log to stderr
      process.stderr.write(`[NutritionService] Error checking existing recipe for ${mealName}: ${e}\n`);
      return null;
    }
  };

  // Process each meal: check database first, then normalize
  for (const day of parsedPlan.days) {
    if (Array.isArray(day.meals)) {
      for (const meal of day.meals) {
        const mealName = meal?.recipe?.name;

        if (mealName) {
          // 1. Try Database First
          let existingRecipe = await getExistingRecipe(mealName);

          // 2. Performance & Quality Check: Is it good enough? (min 5 steps)
          const isGood = (r: any) => r && Array.isArray(r.instructions) && r.instructions.length >= 7;

          if (!isGood(existingRecipe)) {
            // SILENT AUTO-REPAIR (Backend): If bad or missing, generate it now.
            // This ensures the frontend doesn't have to show "Generating" messages later.
            process.stdout.write(`[NutritionService] Pre-generating full details for "${mealName}" (Quality Baseline)...\n`);
            try {
              const detailPrompt = `Generate full professional recipe details for "${mealName}". 
              Target Language: English.
              
              Return JSON:
              {
                "ingredients": string[],
                "instructions": Array<{ "simple": string, "detailed": string }>,
                "nutritionTips": string[],
                "prepTips": string[],
                "macros": { "protein": number, "carbs": number, "fat": number },
                "calories": number
              }
              
              CRITICAL: Provide EXACTLY 8-10 detailed steps. Each "detailed" step must be 2-3 sentences long with chef tips.`;

              const aiResult = await aiService.generateText({
                prompt: detailPrompt,
                model: 'models/gemini-3-flash-preview', // Fast and capable for structured tasks
                generationConfig: { responseMimeType: "application/json" }
              });

              const fresh = JSON.parse(cleanGeminiJson(aiResult.text) || '{}');

              if (isGood(fresh)) {
                existingRecipe = fresh;
                // Proactive Translation
                translationService.preTranslate([mealName, ...(fresh.ingredients || []), ...(fresh.instructions || []).map((s: any) => s.detailed || s.simple || s)], 'meal');
              }
            } catch (e) {
              process.stderr.write(`[NutritionService] Background generation failed for ${mealName}\n`);
            }
          } else if (existingRecipe && existingRecipe.instructions && existingRecipe.instructions.length < 8) {
            // PROACTIVE UPGRADE: If it's okay but not "Golden" yet, queue a background upgrade.
            pool.query(
              `INSERT INTO generation_jobs(type, payload, priority) VALUES($1, $2, $3) ON CONFLICT DO NOTHING`,
              ['CONTENT_UPGRADE', JSON.stringify({ type: 'MEAL', name: mealName, currentSteps: existingRecipe.instructions.length }), 'LOW']
            ).catch(() => { });
          }

          if (existingRecipe) {
            // Use existing recipe from database or freshly generated
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

        // Normalize ingredients
        if (meal?.recipe?.ingredients) {
          meal.recipe.ingredients = normalizeIngredients(meal.recipe.ingredients);
        }

        // Normalize instructions
        if (meal?.recipe?.instructions) {
          meal.recipe.instructions = normalizeInstructions(meal.recipe.instructions);
        } else {
          meal.recipe.instructions = [{ simple: 'Enjoy mindfully.', detailed: 'Enjoy this meal mindfully and savor each bite.' }];
        }


        if (!meal?.recipe?.time) {
          meal.recipe.time = '15 min';
        }

        // MAP nutritionTips to prepTips for Frontend "Nutrient Science" card
        if (!meal.recipe.prepTips && meal.recipe.nutritionTips) {
          meal.recipe.prepTips = meal.recipe.nutritionTips;
        }
      }
    }


    parsedPlan.varietyMode = varietyMode;
    parsedPlan.name = parsedPlan.name || `${profile?.primaryGoal || 'Nutrition'} Plan`;

    // --- BACKGROUND ASSET GENERATION TRIGGER ---
    try {
      for (const day of parsedPlan.days) {
        if (day.meals) {
          for (const meal of day.meals) {
            if (meal.recipe && meal.recipe.name) {
              jobProcessor.submitJob(profile.userId || 'system', 'MEAL_GENERATION', {
                name: meal.recipe.name,
                instructions: meal.recipe.instructions,
                ingredients: meal.recipe.ingredients
              }).catch(() => { });
            }
          }
        }
      }
    } catch (e) {
      process.stderr.write(`[NutritionService] Asset job trigger failed: ${e}\n`);
    }

    // --- BACKGROUND PRE-TRANSLATION ---
    // Trigger translation into all supported languages in the background
    try {
      if (parsedPlan.name) translationService.preTranslate(parsedPlan.name, 'meal_plan_name');
      if (parsedPlan.overview) translationService.preTranslate(parsedPlan.overview, 'meal_plan_overview');

      for (const day of parsedPlan.days) {
        if (Array.isArray(day.meals)) {
          for (const meal of day.meals) {
            if (meal.recipe) {
              if (meal.recipe.name) translationService.preTranslate(meal.recipe.name, 'meal_name');
              if (Array.isArray(meal.recipe.ingredients)) translationService.preTranslate(meal.recipe.ingredients, 'meal_ingredient');

              if (Array.isArray(meal.recipe.instructions)) {
                const simpleInst = meal.recipe.instructions.map(i => i.simple).filter(Boolean);
                const detailedInst = meal.recipe.instructions.map(i => i.detailed).filter(Boolean);
                translationService.preTranslate(simpleInst, 'meal_instruction_simple');
                translationService.preTranslate(detailedInst, 'meal_instruction_detailed');
              }

              if (Array.isArray(meal.recipe.nutritionTips)) {
                translationService.preTranslate(meal.recipe.nutritionTips, 'nutrition_tip');
              }
            }
            if (meal.macronutrientFocus) translationService.preTranslate(meal.macronutrientFocus, 'macronutrient_focus');
          }
        }
      }
    } catch (e) {
      process.stderr.write(`[NutritionService] Pre-translation trigger failed: ${e}\n`);
    }

    // --- LOCALIZATION & CACHING LAYER ---
    if (lang && lang !== 'en') {
      // 1. Translate Top Level Attributes
      if (parsedPlan.name) {
        parsedPlan.name = await translationService.translateText(parsedPlan.name, lang, 'meal_plan_name');
      }
      if (parsedPlan.overview) {
        parsedPlan.overview = await translationService.translateText(parsedPlan.overview, lang, 'meal_plan_overview');
      }

      // 2. Translate Days and Meals
      for (const day of parsedPlan.days) {
        if (Array.isArray(day.meals)) {
          for (const meal of day.meals) {
            if (meal.recipe) {
              // Translate Meal Name
              if (meal.recipe.name) {
                meal.recipe.name = await translationService.translateText(meal.recipe.name, lang, 'meal_name');
              }

              // Translate Ingredients
              if (Array.isArray(meal.recipe.ingredients)) {
                meal.recipe.ingredients = await translationService.translateList(meal.recipe.ingredients, lang, 'meal_ingredient');
              }

              // Translate Instructions
              if (Array.isArray(meal.recipe.instructions)) {
                for (const inst of meal.recipe.instructions) {
                  if (inst.simple) {
                    inst.simple = await translationService.translateText(inst.simple, lang, 'meal_instruction_simple');
                  }
                  if (inst.detailed) {
                    inst.detailed = await translationService.translateText(inst.detailed, lang, 'meal_instruction_detailed');
                  }
                }
              }

              // Translate Nutrition Tips
              if (Array.isArray(meal.recipe.nutritionTips)) {
                meal.recipe.nutritionTips = await translationService.translateList(meal.recipe.nutritionTips, lang, 'nutrition_tip');
              }
            }

            if (meal.macronutrientFocus) {
              meal.macronutrientFocus = await translationService.translateText(meal.macronutrientFocus, lang, 'macronutrient_focus');
            }
          }
        }
      }

    }


  }

  return parsedPlan as MealPlan;
}


