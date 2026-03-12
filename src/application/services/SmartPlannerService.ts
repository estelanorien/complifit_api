/**
 * SmartPlannerService — Coordinated meal + training plan generation via Claude Opus.
 *
 * Generates BOTH plans in a single AI call so nutrition is directly informed by
 * training burns, protein needs, and recovery days. Falls back to separate
 * Gemini-based generation if Claude is unavailable.
 */

import { AiService } from './aiService.js';
import { logger } from '../../infra/logger.js';
import { generateNutritionPlan, MealPlan } from './nutritionService.js';
import { generateTrainingPlan, TrainingPlan } from './trainingService.js';

const aiService = new AiService();

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface SmartPlanRequest {
  profile: {
    age: number;
    gender: string;
    weight: number;       // kg
    height: number;       // cm
    fitnessLevel: string; // beginner, intermediate, advanced
    goal: string;         // lose_weight, build_muscle, maintain, general_fitness
    specificGoals?: string[];
    dietaryPreference?: string; // omnivore, vegetarian, vegan, etc.
    exclusions?: string[];
    medicalConditions?: string[];
    equipment?: string[];
    focusAreas?: string[];
    trainingStyle?: string;
    activityLevel?: string;
    sports?: string[];
    glp1?: boolean;
  };
  days: number;
  lang?: string;
  previousPlan?: any;
  overrideStyle?: string;
}

export interface CoordinationData {
  dailyCalorieTargets: number[];
  proteinTargetsByDay: number[];
  preWorkoutNutrition: string[];
  postWorkoutNutrition: string[];
  recoveryDayNotes: string[];
  weeklyProgressionNotes: string;
}

export interface SmartPlanResponse {
  training: TrainingPlan;
  nutrition: MealPlan;
  coordination: CoordinationData;
  source: 'claude_coordinated' | 'gemini_separate';
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function calculateBMI(weight: number, height: number): number {
  if (!weight || !height) return 0;
  return weight / ((height / 100) ** 2);
}

function calculateBMR(weight: number, height: number, age: number, gender: string): number {
  let bmr = 10 * weight + 6.25 * height - 5 * age;
  bmr += gender === 'male' ? 5 : -161;
  return Math.round(bmr);
}

function activityMultiplier(level?: string): number {
  switch (level?.toLowerCase()) {
    case 'sedentary': return 1.2;
    case 'light': return 1.375;
    case 'moderate': return 1.55;
    case 'active': return 1.725;
    case 'very_active': return 1.9;
    default: return 1.55;
  }
}

function calculateTDEE(weight: number, height: number, age: number, gender: string, activityLevel?: string): number {
  return Math.round(calculateBMR(weight, height, age, gender) * activityMultiplier(activityLevel));
}

function getBMISafetyProtocol(bmi: number): string {
  if (bmi > 30) {
    return `SAFETY PROTOCOL (Obese BMI ${bmi.toFixed(1)}): LOW IMPACT exercises only. No jumping, no high-impact plyometrics. Controlled movements, seated alternatives where possible. Joint protection is critical.`;
  } else if (bmi > 25) {
    return `SAFETY PROTOCOL (Overweight BMI ${bmi.toFixed(1)}): Mixed modality with joint protection. Limit high-impact exercises. Include mobility work.`;
  } else if (bmi > 0 && bmi < 18.5) {
    return `SAFETY PROTOCOL (Underweight BMI ${bmi.toFixed(1)}): HYPERTROPHY FOCUS. Higher calorie surplus with protein emphasis. Compound movements preferred. Avoid excessive cardio.`;
  }
  return 'General Safety: Ensure exercises match fitness level. Proper warm-up required.';
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

class SmartPlannerServiceImpl {

  /**
   * Generate a coordinated training + nutrition plan in a single Claude Opus call.
   * Falls back to separate Gemini-based generation if Claude is unavailable.
   */
  async generate(request: SmartPlanRequest): Promise<SmartPlanResponse> {
    try {
      return await this.generateCoordinated(request);
    } catch (e: any) {
      logger.warn(`[SmartPlanner] Coordinated generation failed, falling back to separate: ${e.message}`);
      return this.generateSeparateFallback(request);
    }
  }

  /**
   * Single coordinated Claude Opus call.
   */
  private async generateCoordinated(req: SmartPlanRequest): Promise<SmartPlanResponse> {
    const { profile, days } = req;
    const bmi = calculateBMI(profile.weight, profile.height);
    const tdee = calculateTDEE(profile.weight, profile.height, profile.age, profile.gender, profile.activityLevel);
    const safetyProtocol = getBMISafetyProtocol(bmi);

    const deficitPerDay = profile.goal === 'lose_weight' ? 500
      : profile.goal === 'build_muscle' ? -300 // surplus
      : 0;

    const targetCalories = tdee - deficitPerDay;

    const systemPrompt = `You are an elite certified sports nutritionist (CISSN) AND certified strength and conditioning specialist (CSCS). You generate COORDINATED fitness plans where nutrition directly supports the training schedule.

SCIENTIFIC PRINCIPLES:
- Protein: 1.6-2.2 g/kg on strength days, 1.2-1.6 g/kg on rest days
- Pre-workout (90 min before): complex carbs + moderate protein (30-40g carbs, 15-20g protein)
- Post-workout (within 30 min): fast protein + simple carbs (25-40g protein, 30-50g carbs)
- Recovery days: anti-inflammatory foods (omega-3, turmeric, berries, leafy greens)
- Weekly calorie target must match user goal (deficit for weight loss, surplus for muscle gain)

${safetyProtocol}

${profile.medicalConditions?.length ? `MEDICAL CONDITIONS: ${profile.medicalConditions.join(', ')}. Adjust exercises and nutrition accordingly.` : ''}
${profile.glp1 ? 'GLP-1 MEDICATION: User is on GLP-1 agonist. Prioritize protein to prevent muscle loss. Smaller, more frequent meals. Avoid high-fat meals that may cause nausea.' : ''}`;

    const prompt = `Generate a ${days}-day COORDINATED training + nutrition plan for this user:

PROFILE:
- Age: ${profile.age}, Gender: ${profile.gender}
- Weight: ${profile.weight}kg, Height: ${profile.height}cm, BMI: ${bmi.toFixed(1)}
- Fitness Level: ${profile.fitnessLevel}
- Goal: ${profile.goal} (daily target: ~${targetCalories} kcal, TDEE: ${tdee})
- Equipment: ${profile.equipment?.join(', ') || 'bodyweight only'}
- Focus Areas: ${profile.focusAreas?.join(', ') || 'full body'}
- Training Style: ${profile.trainingStyle || req.overrideStyle || 'balanced'}
- Diet: ${profile.dietaryPreference || 'omnivore'}
- Exclusions: ${profile.exclusions?.join(', ') || 'none'}
${profile.sports?.length ? `- Sports: ${profile.sports.join(', ')}` : ''}

COORDINATION RULES:
1. Calculate estimated calorie burn for each workout day
2. Set daily calorie target = TDEE (${tdee}) + workout_burn - deficit (${deficitPerDay})
3. Strength training days: protein >= ${Math.round(profile.weight * 1.6)}g (1.6 g/kg)
4. Cardio/HIIT days: higher carbs for fuel
5. Recovery/rest days: anti-inflammatory foods, moderate protein
6. Include pre-workout and post-workout meal timing notes
7. Total weekly deficit/surplus must align with goal

Return ONLY valid JSON with this exact structure:
{
  "training": {
    "name": "Plan name",
    "analysis": "Brief analysis of the user's needs",
    "schedule": [
      {
        "day": "Day 1 - Focus",
        "focus": "Muscle group or type",
        "exercises": [
          {
            "name": "Exercise Name",
            "sets": "3",
            "reps": "10-12",
            "notes": "Form cues",
            "estimatedCalories": 150
          }
        ]
      }
    ],
    "trainingStyle": "style name"
  },
  "nutrition": {
    "name": "Plan name",
    "overview": "Brief nutrition strategy",
    "days": [
      {
        "day": "Day 1",
        "targetCalories": 2200,
        "meals": [
          {
            "type": "breakfast|lunch|dinner|snack|pre_workout|post_workout",
            "recipe": {
              "name": "Meal name",
              "calories": 550,
              "time": "15 min",
              "ingredients": ["ingredient 1", "ingredient 2"],
              "instructions": [
                {"simple": "Short version", "detailed": "Detailed version"}
              ],
              "macros": {"protein": 35, "carbs": 60, "fat": 15},
              "nutritionTips": ["tip"],
              "prepTips": ["tip"],
              "benefits": ["benefit"]
            }
          }
        ]
      }
    ]
  },
  "coordination": {
    "dailyCalorieTargets": [2200, 2400, 2200, 2000, 2400, 2200, 1900],
    "proteinTargetsByDay": [130, 145, 130, 110, 145, 130, 100],
    "preWorkoutNutrition": ["Day 1: oatmeal with banana 90min before", "..."],
    "postWorkoutNutrition": ["Day 1: whey protein shake with berries within 30min", "..."],
    "recoveryDayNotes": ["Day 4: Rest day — anti-inflammatory meals, salmon, berries, leafy greens"],
    "weeklyProgressionNotes": "How to progress this plan week over week"
  }
}`;

    const { data } = await aiService.generateStructuredOutput<{
      training: TrainingPlan;
      nutrition: MealPlan;
      coordination: CoordinationData;
    }>({
      prompt,
      systemPrompt,
      taskType: 'smart_plan',
    });

    // Normalize instructions to {simple, detailed} format
    if (data.nutrition?.days) {
      for (const day of data.nutrition.days) {
        for (const meal of day.meals || []) {
          if (meal.recipe?.instructions) {
            meal.recipe.instructions = meal.recipe.instructions.map((inst: any) => {
              if (typeof inst === 'string') {
                return { simple: inst, detailed: inst };
              }
              return inst;
            });
          }
        }
      }
    }

    logger.info('[SmartPlanner] Coordinated plan generated successfully', {
      days: data.training?.schedule?.length,
      meals: data.nutrition?.days?.length,
      coordinated: true
    });

    return {
      training: data.training,
      nutrition: data.nutrition,
      coordination: data.coordination,
      source: 'claude_coordinated'
    };
  }

  /**
   * Fallback: generate separately via existing services (Gemini).
   */
  private async generateSeparateFallback(req: SmartPlanRequest): Promise<SmartPlanResponse> {
    const [training, nutrition] = await Promise.all([
      generateTrainingPlan({
        profile: req.profile,
        duration: req.days,
        lang: req.lang || 'en',
        overrideStyle: req.overrideStyle,
        previousPlan: req.previousPlan,
      }),
      generateNutritionPlan({
        profile: req.profile,
        days: req.days,
        excludes: req.profile.exclusions || [],
        staples: [],
        lang: req.lang || 'en',
      })
    ]);

    // Build basic coordination data from the separately generated plans
    const dailyCalorieTargets = (nutrition.days || []).map((d: any) => d.targetCalories || 2000);
    const proteinTargetsByDay = dailyCalorieTargets.map(() => Math.round(req.profile.weight * 1.4));

    return {
      training,
      nutrition,
      coordination: {
        dailyCalorieTargets,
        proteinTargetsByDay,
        preWorkoutNutrition: [],
        postWorkoutNutrition: [],
        recoveryDayNotes: [],
        weeklyProgressionNotes: 'Plans generated independently. Consider adjusting nutrition to match training intensity.',
      },
      source: 'gemini_separate'
    };
  }
}

export const smartPlanner = new SmartPlannerServiceImpl();
