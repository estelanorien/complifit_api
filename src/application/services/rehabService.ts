import { AiService } from './aiService.js';

const aiService = new AiService();

const cleanGeminiJson = (text: string): string => {
  if (!text) return text;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
};

type RehabExercise = {
  name: string;
  sets: string;
  reps: string;
  notes?: string;
  estimatedCalories?: number;
  [key: string]: any;
};

type RehabDay = {
  day: string;
  focus: string;
  exercises: RehabExercise[];
};

export type RehabPlan = {
  name?: string;
  analysis?: string;
  schedule: RehabDay[];
  trainingStyle?: string;
};

type GenerateRehabPlanParams = {
  stats: {
    selectedConditions: string[];
    painLevel: number;
    recoveryPhase: string;
    timeSinceEvent?: string;
    mobilityStatus?: string;
  };
  duration: number;
  lang: string;
};

const estimateCalories = (activityName: string, setsStr: string, defaultWeight = 70) => {
  const sets = parseInt(setsStr, 10) || 2;
  const durationMinutes = sets * 4;
  const normalized = activityName?.toLowerCase() || '';
  let met = 3;
  if (normalized.includes('cardio') || normalized.includes('bike')) met = 5;
  else if (normalized.includes('breathing') || normalized.includes('stretch')) met = 2;
  return Math.max(10, Math.round((met * 3.5 * defaultWeight) / 200 * durationMinutes));
};

export async function generateRehabPlan(params: GenerateRehabPlanParams): Promise<RehabPlan> {
  const { stats, duration, lang } = params;

  const promptSections: string[] = [];
  promptSections.push(`You are a licensed physical therapist. Build a ${duration}-day rehab plan in ${lang}.`);
  promptSections.push(`PATIENT STATS: ${JSON.stringify(stats)}`);
  promptSections.push(`
OUTPUT JSON:
{
  "name": "Rehab Protocol",
  "analysis": "Short clinical summary",
  "schedule": [
    {
      "day": "Day 1 - Acute Care",
      "focus": "Inflammation control",
      "exercises": [
        { "name": "Exercise", "sets": "2 x 15s", "reps": "Hold", "notes": "Guidance" }
      ]
    }
  ]
}`);

  const { text } = await aiService.generateText({
    prompt: promptSections.join('\n'),
    model: 'models/gemini-3-flash-preview'
  });

  const parsedPlan = JSON.parse(cleanGeminiJson(text) || '{}');
  if (!parsedPlan || !Array.isArray(parsedPlan.schedule)) {
    throw new Error('Rehab plan parsing failed');
  }

  parsedPlan.schedule.forEach((day: RehabDay) => {
    if (Array.isArray(day.exercises)) {
      day.exercises.forEach(ex => {
        ex.estimatedCalories = estimateCalories(ex.name, ex.sets);
      });
    }
  });

  parsedPlan.trainingStyle = 'rehab';
  parsedPlan.name = parsedPlan.name || 'Recovery Protocol';
  return parsedPlan as RehabPlan;
}


