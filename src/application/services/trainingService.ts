import { AiService } from './aiService.js';
import { translationService } from './translationService.js';
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

type TrainingPlanExercise = {
  name: string;
  sets: string;
  reps: string;
  notes?: string;
  drillContext?: string;
  estimatedCalories?: number;
  [key: string]: any;
};

type TrainingPlanDay = {
  day: string;
  focus: string;
  exercises: TrainingPlanExercise[];
};

export type TrainingPlan = {
  name?: string;
  analysis?: string;
  schedule: TrainingPlanDay[];
  trainingStyle?: string;
  varietyMode?: string;
  originalSchedule?: TrainingPlanDay[];
  isRecovery?: boolean;
};

type GenerateTrainingPlanParams = {
  profile: any;
  metrics?: any;
  duration: number;
  lang: string;
  varietyMode?: string;
  previousPlan?: any;
  varietyInput?: string;
  overrideStyle?: string;
  history?: any[];
};

const estimateCalories = (activityName: string, durationMinutes: number, weightKg: number = 70) => {
  const normalized = activityName?.toLowerCase() || '';
  let met = 6; // moderate default
  if (normalized.includes('hiit') || normalized.includes('sprint')) met = 10;
  else if (normalized.includes('yoga') || normalized.includes('mobility')) met = 3;
  else if (normalized.includes('walk') || normalized.includes('warm')) met = 4;
  return Math.max(15, Math.round((met * 3.5 * weightKg) / 200 * durationMinutes));
};

export async function generateTrainingPlan(params: GenerateTrainingPlanParams): Promise<TrainingPlan> {
  const {
    profile,
    metrics,
    duration,
    lang,
    varietyMode,
    previousPlan,
    varietyInput,
    overrideStyle,
    history
  } = params;

  const profileSummary = {
    name: profile?.name,
    age: profile?.age,
    gender: profile?.gender,
    biologicalSex: profile?.biologicalSex,
    weight: profile?.weight,
    height: profile?.height,
    fitnessLevel: profile?.fitnessLevel,
    primaryGoal: profile?.primaryGoal,
    workoutDaysPerWeek: profile?.workoutDaysPerWeek,
    equipment: profile?.equipment,
    focusAreas: profile?.focusAreas,
    specificGoals: profile?.specificGoals,
    conditions: profile?.conditions,
    sports: profile?.sports,
    trainingStyle: profile?.trainingStyle
  };

  const bmi = (profile.weight && profile.height) ? (profile.weight / ((profile.height / 100) ** 2)) : 0;
  let safetyProtocol = "General Safety: Ensure exercises are appropriate for fitness level.";

  if (bmi > 30) {
    safetyProtocol = `SAFETY PROTOCOL (Obese BMI ${bmi.toFixed(1)}):
      1. LOW IMPACT: Prioritize joint-friendly exercises. Minimize high-impact jumping.
      2. STABILITY: Focus on controlled movements to protect joints.
      3. PROGRESSION: Start with lower volume to gauge tolerance.
      4. AVOID: Box jumps, plyometrics without modification, excessive running on hard surfaces.`;
  } else if (bmi > 25) {
    safetyProtocol = `SAFETY PROTOCOL (Overweight BMI ${bmi.toFixed(1)}):
      1. JOINT PROTECTION: Monitor knee and ankle stress.
      2. MIXED MODALITY: Combine low impact cardio with resistance training.`;
  } else if (bmi > 0 && bmi < 18.5) {
    safetyProtocol = `SAFETY PROTOCOL (Underweight BMI ${bmi.toFixed(1)}):
      1. HYPERTROPHY FOCUS: Prioritize building muscle mass.
      2. NUTRITION SYNC: Ensure training supports surplus, avoid excessive calorie-burning cardio.
      3. STABILITY: Build core and foundational strength.`;
  }

  const promptSections: string[] = [];
  promptSections.push(`You are a senior strength coach. Build a ${duration}-day program in English.`);
  promptSections.push(`USER PROFILE: ${JSON.stringify(profileSummary)}`);
  promptSections.push(safetyProtocol);
  if (metrics) promptSections.push(`RECENT HEALTH METRICS: ${JSON.stringify(metrics)}`);
  if (varietyMode) promptSections.push(`VARIETY MODE: ${varietyMode}. ${varietyInput || ''}`);
  if (overrideStyle) promptSections.push(`FORCE TRAINING STYLE: ${overrideStyle}.`);
  if (previousPlan) promptSections.push(`PREVIOUS PLAN SNAPSHOT: ${JSON.stringify(previousPlan.schedule?.slice(0, 2))}`);
  if (history && history.length) promptSections.push(`EXERCISE HISTORY (last sessions): ${JSON.stringify(history.slice(0, 5))}`);
  promptSections.push(`
  STYLE GUIDE (STRICT ENFORCEMENT):
  1. TONE: Professional, authoritative, encouraging. Use active voice ("Press", "Pull", "Hold").
  2. DETAIL LEVEL: "detailed" steps must be 2-3 sentences long, creating a visual mental image of the movement.
  3. SAFETY: Always include specific cues about joint alignment and breathing.
  4. STEP COUNT: Every exercise MUST have 5-8 distinct steps. Fewer than 5 steps is a FAILURE.

  JSON STRUCTURE & CONSTRAINTS:
  Return JSON exactly in this structure. Constraints are CRITICAL:

  {
    "name": "Program Name",
    "analysis": "Short professional analysis of the plan",
    "schedule": [
      {
        "day": "Day 1 - Push",
        "focus": "Upper Body",
        "exercises": [
          { 
            "name": "Exercise Name", 
            "sets": "3", 
            "reps": "12", 
            "notes": "Specific cue (e.g., 'Keep elbows tucked')", 
            "drillContext": "Optional context",
            "instructions": [
              {
                "simple": "Active voice summary (max 10 words)", 
                "detailed": "Detailed execution instruction. Focus on form, breathing, and muscle engagement. (2-3 sentences)"
              },
              // ... MUST HAVE 5-8 STEPS ...
            ]
          }
        ]
      }
    ]
  }

  CRITICAL QUALITY CHECKS:
  - Check "instructions" array length. If < 5, ADD MORE STEPS breaking down the movement.
  - Ensure "detailed" text is actually detailed.
  `);

  const { text } = await aiService.generateText({
    prompt: promptSections.join('\n'),
    model: 'models/gemini-2.0-flash'
  });

  const parsedPlan = JSON.parse(cleanGeminiJson(text) || '{}');
  if (!parsedPlan || !Array.isArray(parsedPlan.schedule)) {
    throw new Error('Training plan parsing failed');
  }

  // Estimate calories for each exercise
  const weight = profile?.weight || 70;
  parsedPlan.schedule.forEach((day: TrainingPlanDay) => {
    if (Array.isArray(day.exercises)) {
      day.exercises.forEach(ex => {
        const sets = parseInt(ex.sets, 10) || 3;
        const duration = sets * 3;
        ex.estimatedCalories = estimateCalories(ex.name, duration, weight);
      });
    }
  });

  parsedPlan.trainingStyle = overrideStyle || profile?.trainingStyle || 'standard';
  parsedPlan.varietyMode = varietyMode;
  parsedPlan.originalSchedule = JSON.parse(JSON.stringify(parsedPlan.schedule));
  parsedPlan.name = parsedPlan.name || `${profile?.primaryGoal || 'Training'} Protocol`;

  // --- BACKGROUND ASSET GENERATION TRIGGER ---
  try {
    for (const day of parsedPlan.schedule) {
      if (day.exercises) {
        for (const ex of day.exercises) {
          if (ex.name) {
            jobProcessor.submitJob(profile.userId || 'system', 'EXERCISE_GENERATION', {
              name: ex.name,
              instructions: ex.instructions,
              userProfile: profile
            }).catch(() => { });
          }
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[TrainingService] Asset job trigger failed: ${e}\n`);
  }

  // --- BACKGROUND PRE-TRANSLATION ---
  // Trigger translation into all supported languages in the background
  try {
    if (parsedPlan.name) translationService.preTranslate(parsedPlan.name, 'training_plan_name');
    if (parsedPlan.analysis) translationService.preTranslate(parsedPlan.analysis, 'training_plan_analysis');

    for (const day of parsedPlan.schedule) {
      if (day.day) translationService.preTranslate(day.day, 'training_day_name');
      if (day.focus) translationService.preTranslate(day.focus, 'training_day_focus');

      if (Array.isArray(day.exercises)) {
        for (const ex of day.exercises) {
          if (ex.name) translationService.preTranslate(ex.name, 'exercise_name');
          if (ex.notes) translationService.preTranslate(ex.notes, 'exercise_notes');
          if (ex.drillContext) translationService.preTranslate(ex.drillContext, 'exercise_drill_context');
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[TrainingService] Pre-translation trigger failed: ${e}\n`);
  }

  // --- LOCALIZATION & CACHING LAYER ---
  if (lang && lang !== 'en') {
    // 1. Translate Top Level Attributes
    if (parsedPlan.name) {
      parsedPlan.name = await translationService.translateText(parsedPlan.name, lang, 'training_plan_name');
    }
    if (parsedPlan.analysis) {
      parsedPlan.analysis = await translationService.translateText(parsedPlan.analysis, lang, 'training_plan_analysis');
    }

    // 2. Translate Schedule (Days and Exercises)
    for (const day of parsedPlan.schedule) {
      if (day.day) {
        day.day = await translationService.translateText(day.day, lang, 'training_day_name');
      }
      if (day.focus) {
        day.focus = await translationService.translateText(day.focus, lang, 'training_day_focus');
      }

      if (Array.isArray(day.exercises)) {
        for (const ex of day.exercises) {
          if (ex.name) {
            ex.name = await translationService.translateText(ex.name, lang, 'exercise_name');
          }
          if (ex.notes) {
            ex.notes = await translationService.translateText(ex.notes, lang, 'exercise_notes');
          }
          if (ex.drillContext) {
            ex.drillContext = await translationService.translateText(ex.drillContext, lang, 'exercise_drill_context');
          }
        }
      }
    }
  }

  return parsedPlan as TrainingPlan;
}


