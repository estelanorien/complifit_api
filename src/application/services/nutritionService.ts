import { AiService } from './aiService';

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
            "instructions": ["step"],
            "macros": { "protein": 30, "carbs": 50, "fat": 15 }
          },
          "macronutrientFocus": "High Protein"
        }
      ]
    }
  ]
}`);

  const { text } = await aiService.generateText({
    prompt: promptSections.join('\n'),
    model: 'models/gemini-2.0-flash-exp'
  });

  const parsedPlan = JSON.parse(cleanGeminiJson(text) || '{}');
  if (!parsedPlan || !Array.isArray(parsedPlan.days)) {
    throw new Error('Nutrition plan parsing failed');
  }

  parsedPlan.days.forEach((day: MealPlanDay) => {
    if (Array.isArray(day.meals)) {
      day.meals.forEach((meal) => {
        if (meal?.recipe?.ingredients) {
          meal.recipe.ingredients = normalizeIngredients(meal.recipe.ingredients);
        }
        if (!meal?.recipe?.instructions) {
          meal.recipe.instructions = ['Enjoy mindfully.'];
        }
        if (!meal?.recipe?.time) {
          meal.recipe.time = '15 min';
        }
      });
    }
  });

  parsedPlan.varietyMode = varietyMode;
  parsedPlan.name = parsedPlan.name || `${profile?.primaryGoal || 'Nutrition'} Plan`;

  return parsedPlan as MealPlan;
}


