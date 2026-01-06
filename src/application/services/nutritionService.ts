import { AiService } from './aiService';
import { pool } from '../../infra/db/pool';

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

type MealPlanMeal = {
  type: string;
  recipe: {
    name: string;
    calories: number;
    time?: string;
    ingredients?: string[];
    instructions?: string[];
    macros?: any;
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
    medical: profile?.conditions
  };

  const promptSections: string[] = [];
  promptSections.push(`You are a clinical dietitian. Build a ${days}-day meal plan in ${lang}.`);
  promptSections.push(`USER PROFILE: ${JSON.stringify(profileSummary)}`);
  promptSections.push(`EXCLUDES: ${JSON.stringify(excludes || [])}`);
  promptSections.push(`STAPLES: ${JSON.stringify(staples || [])}`);
  if (prioritizeSuperfoods) promptSections.push(`PRIORITIZE SUPERFOODS and anti-inflammatory ingredients.`);
  if (varietyMode) promptSections.push(`VARIETY MODE: ${varietyMode}. ${varietyInput || ''}`);
  if (previousPlan) promptSections.push(`PREVIOUS PLAN SUMMARY: ${JSON.stringify(previousPlan?.days?.slice(0, 2) || [])}`);

  promptSections.push(`
Return JSON exactly as:
{
  "name": "Plan name",
  "overview": "Short summary",
  "days": [
    {
      "day": "Day 1",
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
              "Scientific tip for maximizing nutrients from this meal (e.g., 'Crush garlic 10 minutes before cooking to activate allicin')",
              "Part-specific tip (e.g., 'Eat broccoli stems too - they contain more fiber than florets')"
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
- "simple": Quick mode - Brief, actionable instruction (max 15 words). Example: "Heat oil in pan, add onions, cook 5 min"
- "detailed": Chef mode - Detailed instruction with technique, timing, and tips (2-3 sentences). Example: "Heat 2 tbsp olive oil in a large skillet over medium heat. Add diced onions and cook, stirring occasionally, until translucent and fragrant (about 5 minutes). This builds the flavor base for the dish."
- Use imperative mood (no "you should", just "Heat", "Add", "Cook")
- NO conversational fillers like "Here's how", "First", "Then" - just the instruction

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
`);

  const { text } = await aiService.generateText({
    prompt: promptSections.join('\n'),
    model: 'models/gemini-2.0-flash-exp'
  });

  const parsedPlan = JSON.parse(cleanGeminiJson(text) || '{}');
  if (!parsedPlan || !Array.isArray(parsedPlan.days)) {
    throw new Error('Nutrition plan parsing failed');
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

  return parsedPlan as MealPlan;
}


