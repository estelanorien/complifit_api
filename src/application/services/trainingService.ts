import { AiService } from './aiService.js';
import { translationService } from './translationService.js';

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

  const promptSections: string[] = [];
  promptSections.push(`You are a senior strength coach. Build a ${duration}-day program in English.`);
  promptSections.push(`USER PROFILE: ${JSON.stringify(profileSummary)}`);
  if (metrics) promptSections.push(`RECENT HEALTH METRICS: ${JSON.stringify(metrics)}`);
  if (varietyMode) promptSections.push(`VARIETY MODE: ${varietyMode}. ${varietyInput || ''}`);
  if (overrideStyle) promptSections.push(`FORCE TRAINING STYLE: ${overrideStyle}.`);
  if (previousPlan) promptSections.push(`PREVIOUS PLAN SNAPSHOT: ${JSON.stringify(previousPlan.schedule?.slice(0, 2))}`);
  if (history && history.length) promptSections.push(`EXERCISE HISTORY (last sessions): ${JSON.stringify(history.slice(0, 5))}`);
  promptSections.push(`
Return JSON exactly in this structure:
{
  "name": "Program name",
  "analysis": "Short paragraph",
  "schedule": [
    {
      "day": "Day 1 - Push",
      "focus": "Upper Body",
      "exercises": [
        { "name": "Exercise", "sets": "3", "reps": "12", "notes": "Coaching cues", "drillContext": "Optional" }
      ]
    }
  ]
}`);

  const { text } = await aiService.generateText({
    prompt: promptSections.join('\n'),
    model: 'models/gemini-2.0-flash-exp'
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


