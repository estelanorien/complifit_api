import { z } from 'zod';

export const InstructionBlockSchema = z.object({
    simple: z.string(),
    detailed: z.string()
});

export const MealRecipeSchema = z.object({
    name: z.string(),
    calories: z.number().optional(),
    protein: z.number().optional(),
    carbs: z.number().optional(),
    fat: z.number().optional(),
    time: z.string().optional(),
    ingredients: z.array(z.string()).optional(),
    instructions: z.array(InstructionBlockSchema).optional(),
    nutritionTips: z.array(z.string()).optional(),
    macros: z.record(z.number()).optional() // Macros are numeric values
});

export const MealSchema = z.object({
    type: z.string(),
    calories: z.number().optional(),
    recipe: MealRecipeSchema
});

export const MealPlanDaySchema = z.object({
    day: z.string().optional(),
    meals: z.array(MealSchema),
    targetCalories: z.number().optional(),
});

export const MealPlanSchema = z.object({
    name: z.string().optional(),
    overview: z.string().optional(),
    varietyMode: z.string().optional(),
    days: z.array(MealPlanDaySchema),
});

export const ExerciseSchema = z.object({
    name: z.string(),
    sets: z.string().optional(),
    reps: z.string().optional(),
    notes: z.string().optional(),
    drillContext: z.string().optional(),
    instructions: z.array(InstructionBlockSchema).optional(),
    targetMuscles: z.string().nullable().optional(),
    equipment: z.string().nullable().optional(),
    difficulty: z.string().nullable().optional(),
    estimatedCalories: z.number().optional()
});

export const TrainingDaySchema = z.object({
    day: z.string().optional(),
    focus: z.string().optional(),
    recovery: z.boolean().optional(),
    exercises: z.array(ExerciseSchema).optional()
});

export const TrainingPlanSchema = z.object({
    name: z.string().optional(),
    analysis: z.string().optional(),
    trainingStyle: z.string().optional(),
    varietyMode: z.string().optional(),
    schedule: z.array(TrainingDaySchema),
});

export const BioMemorySchema = z.object({
    observations: z.array(z.string())
});

export const UserProfileSchema = z.object({
    id: z.string().optional(),
    email: z.string().email().optional(),
    age: z.coerce.number().optional(),
    gender: z.string().optional(),
    biologicalSex: z.string().optional(),
    weight: z.coerce.number().optional(),
    height: z.coerce.number().optional(),
    fitnessLevel: z.string().optional(),
    primaryGoal: z.string().optional(),
    workoutDaysPerWeek: z.coerce.number().optional(),
    focusAreas: z.array(z.string()).optional(),
    equipment: z.array(z.string()).optional(),
    dietaryPreference: z.string().optional(),
    excludedIngredients: z.array(z.string()).optional(),
    preferredCuisines: z.array(z.string()).optional(),
    conditions: z.array(z.string()).optional(),
    specificGoals: z.array(z.string()).optional(),
    nutritionGoals: z.array(z.string()).optional(),
    sports: z.array(z.string()).optional(),
    trainingStyle: z.string().optional(),
    glp1Mode: z.boolean().optional(),
    bioMemory: BioMemorySchema.optional(),
});

export const PlanSettingsSchema = z.object({
    frequency: z.coerce.number().optional(),
    intensity: z.string().optional(),
    duration: z.coerce.number().optional(),
    dietType: z.string().optional(),
    mealFrequency: z.string().optional(),
    cookingTime: z.string().optional(),
    debtStrategy: z.string().optional(),
    cycleGoal: z.string().optional(),
    nutritionGoal: z.string().optional(),
});

export const CalculatedBiometricsSchema = z.object({
    tdee: z.number().optional(),
    target: z.number().optional(),
    safetyFloor: z.number().optional(),
    bmr: z.number().optional(),
    bodyFat: z.number().optional(),
}).passthrough(); // Allow additional fields but validate known ones

export const MetricsSchema = z.object({
    weight: z.number().optional(),
    bodyFat: z.number().optional(),
    muscleMass: z.number().optional(),
    bmr: z.number().optional(),
    tdee: z.number().optional(),
}).passthrough();

export const TrainingHistorySchema = z.object({
    date: z.string().optional(),
    exercises: z.array(z.string()).optional(),
    volume: z.number().optional(),
}).passthrough();
