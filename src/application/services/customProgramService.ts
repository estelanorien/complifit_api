import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../../config/env.js';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export class CustomProgramService {
    /**
     * Extract text from an uploaded image using Gemini Vision
     */
    static async extractTextFromImage(imageBase64: string, mimeType: string): Promise<string> {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

            const prompt = `You are an OCR assistant. Extract ALL text from this image. The image may contain:
- A training/workout program (exercises, sets, reps, notes)
- A meal/nutrition plan (meals, ingredients, calories, macros)
- A combination of both

Please extract the text EXACTLY as it appears, preserving structure, line breaks, and formatting.
Do not add any commentary or interpretation. Just return the raw text.`;

            const result = await model.generateContent([
                prompt,
                {
                    inlineData: {
                        data: imageBase64,
                        mimeType
                    }
                }
            ]);

            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('OCR extraction failed:', error);
            throw new Error('Failed to extract text from image');
        }
    }

    /**
     * Convert approved text into a structured TrainingProgram
     */
    static async parseTrainingProgram(text: string, userProfile: any): Promise<any> {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

            const prompt = `You are a fitness AI. Convert this training plan text into a structured JSON format.

USER PROFILE:
- Age: ${userProfile.age}
- Gender: ${userProfile.gender}
- Fitness Level: ${userProfile.fitnessLevel}
- Equipment: ${userProfile.equipment?.join(', ') || 'Unknown'}
- Conditions: ${userProfile.conditions?.join(', ') || 'None'}

TRAINING PLAN TEXT:
${text}

Convert this into a TrainingProgram object with the following structure:
{
  "name": "Program name (infer from text or create one)",
  "schedule": [
    {
      "day": "Day name (e.g., 'Monday', 'Day 1', 'Push Day')",
      "focus": "Focus area (e.g., 'Upper Body', 'Legs', 'Cardio')",
      "exercises": [
        {
          "name": "Exercise name",
          "sets": "Sets (e.g., '3', '3-4')",
          "reps": "Reps (e.g., '10', '8-12', '30 seconds')",
          "notes": "Any additional notes or instructions"
        }
      ]
    }
  ],
  "source": "custom_manual"
}

IMPORTANT:
- If days are not explicitly named, use "Day 1", "Day 2", etc.
- If it's a rotation (Push/Pull/Legs), use those as day names
- Infer focus areas from exercises if not stated
- Keep all original exercise names and notes
- Return ONLY valid JSON, no markdown or explanation`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const jsonText = response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            return JSON.parse(jsonText);
        } catch (error) {
            console.error('Training program parsing failed:', error);
            throw new Error('Failed to parse training program');
        }
    }

    /**
     * Convert approved text into a structured WeeklyMealPlan
     */
    static async parseNutritionPlan(text: string, userProfile: any): Promise<any> {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

            const prompt = `You are a nutrition AI. Convert this meal plan text into a structured JSON format.

USER PROFILE:
- Age: ${userProfile.age}
- Gender: ${userProfile.gender}
- Primary Goal: ${userProfile.primaryGoal}
- Dietary Preference: ${userProfile.dietaryPreference}

MEAL PLAN TEXT:
${text}

Convert this into a WeeklyMealPlan object with the following structure:
{
  "name": "Plan name (infer from text or create one)",
  "overview": "Brief summary of the plan",
  "days": [
    {
      "day": "Day name (e.g., 'Monday', 'Day 1')",
      "targetCalories": estimated_total_calories_for_day,
      "meals": [
        {
          "type": "breakfast|lunch|dinner|snack|pre_workout|post_workout",
          "recipe": {
            "name": "Meal name",
            "calories": estimated_calories,
            "ingredients": ["Ingredient 1", "Ingredient 2"],
            "instructions": ["Step 1", "Step 2"],
            "macros": {
              "protein": estimated_grams,
              "carbs": estimated_grams,
              "fat": estimated_grams
            }
          }
        }
      ]
    }
  ],
  "source": "custom_manual"
}

IMPORTANT:
- Estimate calories and macros if not provided
- Infer meal types from timing or context
- If days are not named, use "Day 1", "Day 2", etc.
- Keep all original ingredient lists and instructions
- Return ONLY valid JSON, no markdown or explanation`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const jsonText = response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            return JSON.parse(jsonText);
        } catch (error) {
            console.error('Nutrition plan parsing failed:', error);
            throw new Error('Failed to parse nutrition plan');
        }
    }

    /**
     * Validate a custom program (Free tier)
     */
    static async validateProgram(program: any, type: 'training' | 'nutrition', userProfile: any): Promise<any> {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

            const prompt = type === 'training'
                ? `You are a fitness safety validator. Review this training program for basic safety issues.

USER PROFILE:
- Age: ${userProfile.age}, Gender: ${userProfile.gender}
- Fitness Level: ${userProfile.fitnessLevel}
- Conditions: ${userProfile.conditions?.join(', ') || 'None'}
- Injuries: ${userProfile.injuries?.join(', ') || 'None'}

PROGRAM:
${JSON.stringify(program, null, 2)}

Provide validation feedback in this JSON structure:
{
  "overallScore": 0-100,
  "concerns": ["List of safety concerns or missing elements"],
  "strengths": ["List of positive aspects"],
  "isApproved": true/false
}

Focus on:
- Safety for user's conditions/injuries
- Missing muscle groups
- Volume appropriateness
- Rest/recovery

Return ONLY valid JSON.`
                : `You are a nutrition safety validator. Review this meal plan for basic safety issues.

USER PROFILE:
- Age: ${userProfile.age}, Gender: ${userProfile.gender}
- Goal: ${userProfile.primaryGoal}
- Dietary Preference: ${userProfile.dietaryPreference}

PLAN:
${JSON.stringify(program, null, 2)}

Provide validation feedback in this JSON structure:
{
  "overallScore": 0-100,
  "concerns": ["List of nutrition concerns"],
  "strengths": ["List of positive aspects"],
  "isApproved": true/false
}

Focus on:
- Calorie appropriateness for goal
- Macro balance
- Dietary restriction compliance
- Missing nutrients

Return ONLY valid JSON.`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const jsonText = response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            return JSON.parse(jsonText);
        } catch (error) {
            console.error('Program validation failed:', error);
            throw new Error('Failed to validate program');
        }
    }

    /**
     * Comprehensive coaching feedback (Pro tier)
     */
    static async provideCoachingFeedback(program: any, type: 'training' | 'nutrition', userProfile: any): Promise<any> {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

            const prompt = type === 'training'
                ? `You are an expert fitness coach. Provide comprehensive feedback on this training program.

USER PROFILE:
- Age: ${userProfile.age}, Gender: ${userProfile.gender}
- Fitness Level: ${userProfile.fitnessLevel}
- Goal: ${userProfile.primaryGoal}
- Equipment: ${userProfile.equipment?.join(', ')}
- Sports: ${userProfile.sports?.join(', ') || 'None'}

PROGRAM:
${JSON.stringify(program, null, 2)}

Provide detailed coaching feedback in this JSON structure:
{
  "overallScore": 0-100,
  "strengths": ["Detailed positive aspects"],
  "concerns": ["Detailed concerns with reasoning"],
  "suggestions": [
    {
      "day": day_index_or_null,
      "suggestion": "Specific actionable suggestion",
      "reason": "Why this matters"
    }
  ],
  "personalFit": "How well this matches user's profile and goals",
  "volumeAnalysis": "Assessment of training volume",
  "progressionPath": "Recommendations for progression over time"
}

Return ONLY valid JSON.`
                : `You are an expert nutrition coach. Provide comprehensive feedback on this meal plan.

USER PROFILE:
- Age: ${userProfile.age}, Gender: ${userProfile.gender}
- Goal: ${userProfile.primaryGoal}
- Dietary Preference: ${userProfile.dietaryPreference}
- Activity: ${userProfile.workoutDaysPerWeek} days/week

PLAN:
${JSON.stringify(program, null, 2)}

Provide detailed coaching feedback in this JSON structure:
{
  "overallScore": 0-100,
  "strengths": ["Detailed positive aspects"],
  "concerns": ["Detailed concerns with reasoning"],
  "suggestions": [
    {
      "day": day_index_or_null,
      "suggestion": "Specific actionable suggestion",
      "reason": "Why this matters"
    }
  ],
  "personalFit": "How well this matches user's profile and goals",
  "macroAnalysis": "Assessment of macro distribution",
  "timingOptimization": "Recommendations for nutrient timing"
}

Return ONLY valid JSON.`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            const jsonText = response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            return JSON.parse(jsonText);
        } catch (error) {
            console.error('Coaching feedback failed:', error);
            throw new Error('Failed to provide coaching feedback');
        }
    }
}
