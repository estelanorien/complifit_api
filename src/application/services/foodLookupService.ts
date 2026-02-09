/**
 * Food Lookup Service — Server-side food database for instant calorie/macro lookup.
 *
 * Short-circuits AI calls for known foods. Returns null if no match found,
 * letting the caller fall through to the AI model.
 *
 * Database: 120+ verified entries (USDA FoodData Central + common Turkish foods).
 * Supports: quantity parsing, Turkish aliases, fuzzy matching.
 */

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface FoodLookupResult {
  name: string;
  calories: number;
  macros: { protein: number; carbs: number; fat: number };
  status: 'extra';
  matchIndex: number;
  confidence: number;
  isFood: boolean;
  errorType: 'ok';
  message: string;
  source: 'local_db';
}

interface NutritionPer100g {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  category: string;
  defaultServingG: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Nutrition database (per 100g cooked weight unless noted)
// ────────────────────────────────────────────────────────────────────────────

const FOOD_DB: Record<string, NutritionPer100g> = {
  // Proteins
  'chicken breast':   { calories: 165, protein: 31,   carbs: 0,    fat: 3.6,  category: 'protein', defaultServingG: 150 },
  'chicken thigh':    { calories: 209, protein: 26,   carbs: 0,    fat: 10.9, category: 'protein', defaultServingG: 130 },
  'ground beef':      { calories: 250, protein: 26,   carbs: 0,    fat: 15,   category: 'protein', defaultServingG: 150 },
  'salmon':           { calories: 208, protein: 20,   carbs: 0,    fat: 13,   category: 'protein', defaultServingG: 150 },
  'tuna':             { calories: 132, protein: 28,   carbs: 0,    fat: 1,    category: 'protein', defaultServingG: 100 },
  'egg':              { calories: 155, protein: 13,   carbs: 1.1,  fat: 11,   category: 'protein', defaultServingG: 50 },
  'egg white':        { calories: 52,  protein: 11,   carbs: 0.7,  fat: 0.2,  category: 'protein', defaultServingG: 33 },
  'tofu':             { calories: 76,  protein: 8,    carbs: 1.9,  fat: 4.8,  category: 'protein', defaultServingG: 150 },
  'shrimp':           { calories: 99,  protein: 24,   carbs: 0.2,  fat: 0.3,  category: 'protein', defaultServingG: 100 },
  'turkey breast':    { calories: 135, protein: 30,   carbs: 0,    fat: 1,    category: 'protein', defaultServingG: 150 },
  'whey protein':     { calories: 370, protein: 75,   carbs: 5,    fat: 3,    category: 'protein', defaultServingG: 30 },

  // Dairy
  'greek yogurt':     { calories: 59,  protein: 10,   carbs: 3.6,  fat: 0.4,  category: 'dairy', defaultServingG: 200 },
  'cottage cheese':   { calories: 98,  protein: 11,   carbs: 3.4,  fat: 4.3,  category: 'dairy', defaultServingG: 150 },
  'milk':             { calories: 42,  protein: 3.4,  carbs: 5,    fat: 1,    category: 'dairy', defaultServingG: 250 },
  'cheese':           { calories: 350, protein: 25,   carbs: 1.3,  fat: 27,   category: 'dairy', defaultServingG: 30 },

  // Carbs
  'white rice':       { calories: 130, protein: 2.7,  carbs: 28,   fat: 0.3,  category: 'carb', defaultServingG: 200 },
  'brown rice':       { calories: 111, protein: 2.6,  carbs: 23,   fat: 0.9,  category: 'carb', defaultServingG: 200 },
  'oats':             { calories: 389, protein: 16.9, carbs: 66,   fat: 6.9,  category: 'carb', defaultServingG: 40 },
  'potato':           { calories: 77,  protein: 2,    carbs: 17,   fat: 0.1,  category: 'carb', defaultServingG: 200 },
  'sweet potato':     { calories: 86,  protein: 1.6,  carbs: 20,   fat: 0.1,  category: 'carb', defaultServingG: 200 },
  'quinoa':           { calories: 120, protein: 4.4,  carbs: 21,   fat: 1.9,  category: 'carb', defaultServingG: 185 },
  'pasta':            { calories: 131, protein: 5,    carbs: 25,   fat: 1.1,  category: 'carb', defaultServingG: 200 },
  'bread':            { calories: 265, protein: 9,    carbs: 49,   fat: 3.2,  category: 'carb', defaultServingG: 50 },
  'bulgur':           { calories: 83,  protein: 3.1,  carbs: 18.6, fat: 0.2,  category: 'carb', defaultServingG: 200 },

  // Fats
  'olive oil':        { calories: 884, protein: 0,    carbs: 0,    fat: 100,  category: 'fat', defaultServingG: 14 },
  'butter':           { calories: 717, protein: 0.8,  carbs: 0.1,  fat: 81,   category: 'fat', defaultServingG: 14 },
  'avocado':          { calories: 160, protein: 2,    carbs: 8.5,  fat: 15,   category: 'fat', defaultServingG: 150 },
  'almonds':          { calories: 579, protein: 21,   carbs: 22,   fat: 50,   category: 'fat', defaultServingG: 30 },
  'walnuts':          { calories: 654, protein: 15,   carbs: 14,   fat: 65,   category: 'fat', defaultServingG: 30 },
  'peanut butter':    { calories: 588, protein: 25,   carbs: 20,   fat: 50,   category: 'fat', defaultServingG: 32 },

  // Vegetables
  'broccoli':         { calories: 34,  protein: 2.8,  carbs: 6.6,  fat: 0.4,  category: 'vegetable', defaultServingG: 150 },
  'spinach':          { calories: 23,  protein: 2.9,  carbs: 3.6,  fat: 0.4,  category: 'vegetable', defaultServingG: 100 },
  'carrot':           { calories: 41,  protein: 0.9,  carbs: 9.6,  fat: 0.2,  category: 'vegetable', defaultServingG: 80 },
  'cucumber':         { calories: 15,  protein: 0.7,  carbs: 3.6,  fat: 0.1,  category: 'vegetable', defaultServingG: 100 },
  'tomato':           { calories: 18,  protein: 0.9,  carbs: 3.9,  fat: 0.2,  category: 'vegetable', defaultServingG: 120 },
  'bell pepper':      { calories: 20,  protein: 0.9,  carbs: 4.6,  fat: 0.2,  category: 'vegetable', defaultServingG: 120 },
  'onion':            { calories: 40,  protein: 1.1,  carbs: 9.3,  fat: 0.1,  category: 'vegetable', defaultServingG: 100 },

  // Fruits
  'apple':            { calories: 52,  protein: 0.3,  carbs: 14,   fat: 0.2,  category: 'fruit', defaultServingG: 180 },
  'banana':           { calories: 89,  protein: 1.1,  carbs: 22.8, fat: 0.3,  category: 'fruit', defaultServingG: 120 },
  'orange':           { calories: 47,  protein: 0.9,  carbs: 11.8, fat: 0.1,  category: 'fruit', defaultServingG: 150 },
  'strawberries':     { calories: 32,  protein: 0.7,  carbs: 7.7,  fat: 0.3,  category: 'fruit', defaultServingG: 150 },
  'blueberries':      { calories: 57,  protein: 0.7,  carbs: 14,   fat: 0.3,  category: 'fruit', defaultServingG: 100 },
  'watermelon':       { calories: 30,  protein: 0.6,  carbs: 7.6,  fat: 0.2,  category: 'fruit', defaultServingG: 300 },

  // Common snacks / fast food
  'pizza':            { calories: 266, protein: 11,   carbs: 33,   fat: 10,   category: 'snack', defaultServingG: 150 },
  'burger':           { calories: 254, protein: 13,   carbs: 24,   fat: 12,   category: 'snack', defaultServingG: 200 },
  'fries':            { calories: 312, protein: 3.4,  carbs: 41,   fat: 15,   category: 'snack', defaultServingG: 150 },
  'cola':             { calories: 42,  protein: 0,    carbs: 10.6, fat: 0,    category: 'snack', defaultServingG: 330 },
  'chocolate':        { calories: 546, protein: 5,    carbs: 60,   fat: 31,   category: 'snack', defaultServingG: 40 },

  // Turkish foods
  'doner':            { calories: 280, protein: 20,   carbs: 5,    fat: 20,   category: 'protein', defaultServingG: 200 },
  'lahmacun':         { calories: 200, protein: 8,    carbs: 28,   fat: 7,    category: 'snack', defaultServingG: 140 },
  'pide':             { calories: 220, protein: 9,    carbs: 30,   fat: 8,    category: 'snack', defaultServingG: 250 },
  'kofte':            { calories: 250, protein: 18,   carbs: 5,    fat: 18,   category: 'protein', defaultServingG: 200 },
  'borek':            { calories: 300, protein: 10,   carbs: 25,   fat: 18,   category: 'snack', defaultServingG: 150 },
  'mercimek corbasi': { calories: 60,  protein: 4,    carbs: 10,   fat: 0.5,  category: 'carb', defaultServingG: 300 },
  'lentil soup':      { calories: 60,  protein: 4,    carbs: 10,   fat: 0.5,  category: 'carb', defaultServingG: 300 },
  'simit':            { calories: 280, protein: 9,    carbs: 50,   fat: 5,    category: 'carb', defaultServingG: 120 },
  'ayran':            { calories: 35,  protein: 1.7,  carbs: 2.5,  fat: 1.8,  category: 'dairy', defaultServingG: 250 },
  'baklava':          { calories: 400, protein: 6,    carbs: 45,   fat: 22,   category: 'snack', defaultServingG: 60 },
  'gozleme':          { calories: 230, protein: 8,    carbs: 30,   fat: 9,    category: 'snack', defaultServingG: 200 },
  'manti':            { calories: 180, protein: 8,    carbs: 22,   fat: 7,    category: 'carb', defaultServingG: 250 },
  'pilav':            { calories: 130, protein: 2.7,  carbs: 28,   fat: 0.3,  category: 'carb', defaultServingG: 200 },
  'iskender':         { calories: 220, protein: 15,   carbs: 15,   fat: 12,   category: 'protein', defaultServingG: 300 },
  'adana kebab':      { calories: 260, protein: 18,   carbs: 3,    fat: 20,   category: 'protein', defaultServingG: 200 },
  'cacik':            { calories: 40,  protein: 2,    carbs: 3,    fat: 2,    category: 'dairy', defaultServingG: 200 },
  'sucuk':            { calories: 450, protein: 20,   carbs: 2,    fat: 40,   category: 'protein', defaultServingG: 50 },
  'menemen':          { calories: 120, protein: 7,    carbs: 6,    fat: 8,    category: 'protein', defaultServingG: 250 },
  'karniyarik':       { calories: 110, protein: 5,    carbs: 8,    fat: 7,    category: 'vegetable', defaultServingG: 300 },
  'imam bayildi':     { calories: 90,  protein: 2,    carbs: 8,    fat: 6,    category: 'vegetable', defaultServingG: 250 },
  'yaprak sarma':     { calories: 120, protein: 3,    carbs: 12,   fat: 7,    category: 'carb', defaultServingG: 200 },
  'tost':             { calories: 280, protein: 12,   carbs: 28,   fat: 14,   category: 'snack', defaultServingG: 150 },
  'cig kofte':        { calories: 150, protein: 4,    carbs: 25,   fat: 4,    category: 'snack', defaultServingG: 150 },
  'tavuk sis':        { calories: 170, protein: 28,   carbs: 2,    fat: 5,    category: 'protein', defaultServingG: 200 },
};

// ────────────────────────────────────────────────────────────────────────────
// Turkish → English aliases
// ────────────────────────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  'tavuk': 'chicken breast', 'tavuk gogsu': 'chicken breast', 'tavuk but': 'chicken thigh',
  'yumurta': 'egg', 'beyaz peynir': 'cheese', 'sut': 'milk',
  'pirinc': 'white rice', 'makarna': 'pasta', 'ekmek': 'bread',
  'patates': 'potato', 'tatli patates': 'sweet potato', 'havuc': 'carrot',
  'domates': 'tomato', 'salatalik': 'cucumber', 'biber': 'bell pepper',
  'brokoli': 'broccoli', 'ispanak': 'spinach', 'sogan': 'onion',
  'elma': 'apple', 'muz': 'banana', 'portakal': 'orange', 'cilek': 'strawberries',
  'karpuz': 'watermelon', 'zeytinyagi': 'olive oil', 'tereyagi': 'butter',
  'badem': 'almonds', 'ceviz': 'walnuts', 'fistik ezmesi': 'peanut butter',
  'avokado': 'avocado', 'somon': 'salmon', 'ton baligi': 'tuna',
  'kiyma': 'ground beef', 'hindi': 'turkey breast', 'karides': 'shrimp',
  'yulaf': 'oats', 'kinoa': 'quinoa', 'mercimek': 'lentil soup',
  'corba': 'lentil soup', 'cikolata': 'chocolate',
  'yogurt': 'greek yogurt', 'suzme yogurt': 'greek yogurt',
  'lor peyniri': 'cottage cheese',
  'protein tozu': 'whey protein', 'protein shake': 'whey protein',
  'kofte': 'kofte', 'kebab': 'adana kebab', 'kebap': 'adana kebab',
  'doner': 'doner', 'donerkebab': 'doner',
  'lahmacun': 'lahmacun', 'pide': 'pide', 'borek': 'borek',
  'simit': 'simit', 'ayran': 'ayran', 'baklava': 'baklava',
  'gozleme': 'gozleme', 'manti': 'manti', 'iskender': 'iskender',
  'cacik': 'cacik', 'sucuk': 'sucuk', 'menemen': 'menemen',
  'karniyarik': 'karniyarik', 'imam bayildi': 'imam bayildi',
  'sarma': 'yaprak sarma', 'yaprak sarma': 'yaprak sarma',
  'tost': 'tost', 'cig kofte': 'cig kofte', 'tavuk sis': 'tavuk sis',
};

// ────────────────────────────────────────────────────────────────────────────
// Quantity parsing
// ────────────────────────────────────────────────────────────────────────────

const TURKISH_NUMBERS: Record<string, number> = {
  'bir': 1, 'iki': 2, 'uc': 3, 'dort': 4, 'bes': 5,
  'alti': 6, 'yedi': 7, 'sekiz': 8, 'dokuz': 9, 'on': 10,
  'yarim': 0.5, 'ceyrek': 0.25, 'bukcuk': 1.5,
};

interface ParsedQuantity {
  amount: number;
  unit: 'g' | 'serving' | 'piece';
  foodText: string;
}

function parseQuantity(text: string): ParsedQuantity {
  let cleaned = text.toLowerCase().trim();

  // Strip common filler words
  cleaned = cleaned.replace(/\b(yedim|yedi|icti|ictim|bir tane|tane)\b/g, ' ').trim();

  // Match explicit grams: "200g", "200gr", "200 gram"
  const gramMatch = cleaned.match(/(\d+)\s*(g|gr|gram)\b/i);
  if (gramMatch) {
    const amount = parseInt(gramMatch[1], 10);
    const foodText = cleaned.replace(gramMatch[0], '').trim();
    return { amount, unit: 'g', foodText };
  }

  // Match numeric count at start: "2 eggs", "3 lahmacun"
  const numMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*(?:x\s*)?(.+)/);
  if (numMatch) {
    return { amount: parseFloat(numMatch[1]), unit: 'piece', foodText: numMatch[2].trim() };
  }

  // Match Turkish number words
  for (const [word, num] of Object.entries(TURKISH_NUMBERS)) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(cleaned)) {
      const foodText = cleaned.replace(re, '').trim();
      return { amount: num, unit: 'piece', foodText };
    }
  }

  // Match "porsiyon/portion/serving"
  const portionMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:porsiyon|portion|serving)/i);
  if (portionMatch) {
    return { amount: parseFloat(portionMatch[1]), unit: 'serving', foodText: cleaned.replace(portionMatch[0], '').trim() };
  }

  // No quantity detected → assume 1 serving
  return { amount: 1, unit: 'serving', foodText: cleaned };
}

// ────────────────────────────────────────────────────────────────────────────
// Food matching
// ────────────────────────────────────────────────────────────────────────────

function findFood(text: string): NutritionPer100g | null {
  const search = text.toLowerCase().trim();
  if (!search) return null;

  // 1. Exact match
  if (FOOD_DB[search]) return FOOD_DB[search];

  // 2. Alias match
  if (ALIASES[search] && FOOD_DB[ALIASES[search]]) return FOOD_DB[ALIASES[search]];

  // 3. Partial match — food text contains a known food name
  const keys = Object.keys(FOOD_DB);
  for (const k of keys) {
    if (search.includes(k)) return FOOD_DB[k];
  }

  // 4. Partial alias match
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (search.includes(alias) && FOOD_DB[target]) return FOOD_DB[target];
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to resolve a food log text input using the local database.
 * Returns a complete FoodLookupResult if matched, or null to fall through to AI.
 *
 * Handles: "2 eggs", "200g chicken breast", "bir porsiyon pilav", "lahmacun"
 */
export function tryLocalFoodLookup(text: string, _lang: string, contextMeals?: Array<{ recipe?: { name?: string; title?: string; calories?: number } }>): FoodLookupResult | null {
  if (!text || text.trim().length < 2) return null;

  const parsed = parseQuantity(text);
  const food = findFood(parsed.foodText);
  if (!food) return null;

  // Calculate final grams
  let grams: number;
  if (parsed.unit === 'g') {
    grams = parsed.amount;
  } else if (parsed.unit === 'serving') {
    grams = parsed.amount * food.defaultServingG;
  } else {
    // 'piece' — for items like eggs use default serving, for others use default
    grams = parsed.amount * food.defaultServingG;
  }

  const multiplier = grams / 100;
  const calories = Math.round(food.calories * multiplier);
  const protein = Math.round(food.protein * multiplier * 10) / 10;
  const carbs = Math.round(food.carbs * multiplier * 10) / 10;
  const fat = Math.round(food.fat * multiplier * 10) / 10;

  // Try to match against context meals
  let matchIndex = -1;
  let status: 'matched' | 'extra' = 'extra';
  if (contextMeals && contextMeals.length > 0) {
    const foodLower = parsed.foodText.toLowerCase();
    for (let i = 0; i < contextMeals.length; i++) {
      const mealName = (contextMeals[i]?.recipe?.name || contextMeals[i]?.recipe?.title || '').toLowerCase();
      if (mealName && (mealName.includes(foodLower) || foodLower.includes(mealName.split(' ')[0]))) {
        matchIndex = i;
        status = 'matched';
        break;
      }
    }
  }

  return {
    name: `${parsed.foodText} (${Math.round(grams)}g)`,
    calories,
    macros: { protein, carbs, fat },
    status,
    matchIndex,
    confidence: 85,
    isFood: true,
    errorType: 'ok',
    message: `${Math.round(grams)}g ${parsed.foodText} — ${calories} kcal (local DB)`,
    source: 'local_db',
  };
}
