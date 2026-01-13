import { AiService } from './aiService';
import { pool } from '../../infra/db/pool';
import { translationService } from './translationService';

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

    promptSections.push(`
    Return JSON exactly as:
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
                "name": "Meal",
                "calories": 500,
                "time": "15 min",
                "ingredients": ["item"],
                "instructions": [
                  {
                    "simple": "Quick 1-sentence instruction (max 15 words, imperative mood)",
                    "detailed": "Detailed step-by-step instruction with chef tips, timing, and technique notes (2-3 sentences)"
                  }
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
    
    CRITICAL INSTRUCTIONS FOR RECIPE STEPS:
    - Each instruction MUST be an object with "simple" and "detailed" fields
    - Use imperative mood (no "you should", just "Heat", "Add", "Cook")
    - NO conversational fillers
    `);

    const { text } = await aiService.generateText({
      prompt: promptSections.join('\n'),
      model: 'models/gemini-1.5-flash'
    });

    const parsed = JSON.parse(cleanGeminiJson(text) || '{}');
    if (!parsed || !Array.isArray(parsed.days)) {
      throw new Error('Nutrition plan chunk parsing failed');
    }
    return parsed;
  };

  // Main Execution Loop
  let finalDays: MealPlanDay[] = [];
  let planName = "";
  let planOverview = "";

  for (let i = 1; i <= days; i += BATCH_SIZE) {
    const remaining = days - i + 1;
    const currentChunkSize = Math.min(remaining, BATCH_SIZE);

    try {
      // Pass the previous chunk as "previousPlan" for continuity if not the first chunk
      const prevContext = i > 1 ? { days: finalDays } : previousPlan;

      const chunk = await generateBatch(i, currentChunkSize, prevContext);

      if (i === 1) {
        planName = chunk.name || `Nutrition Plan (${days} Days)`;
        planOverview = chunk.overview || "";
      }

      if (chunk.days) {
        finalDays = [...finalDays, ...chunk.days];
      }
    } catch (e) {
      console.error(`Error generating batch starting day ${i}:`, e);
      // Don't fail entire plan if one chunk fails, but maybe throw if empty?
      if (finalDays.length === 0) throw e;
    }
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
          // Check database for existing recipe
          const existingRecipe = await getExistingRecipe(mealName);

          if (existingRecipe) {
            // Use existing recipe from database
            // Service doesn't have req logger, skip logging or use process.stdout
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
      }
    }
  }

  parsedPlan.varietyMode = varietyMode;
  parsedPlan.name = parsedPlan.name || `${profile?.primaryGoal || 'Nutrition'} Plan`;

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

  return parsedPlan as MealPlan;
}


