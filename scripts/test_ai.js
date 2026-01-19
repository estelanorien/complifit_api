
import { AiService } from '../src/application/services/aiService.js';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    const ai = new AiService();
    const prompt = "FEATURING COACH ATLAS: 28-year-old Caucasian male, athletic build, bald head, clean shaven. Wearing a tight Slate Grey compression t-shirt and solid black athletic shorts. No logos. STRICTLY clean shaven. Maintain identical facial features to reference. system_coach_atlas_ref SUBJECT: Single subject centered. Bench Press full body athletic hero pose. Perfect execution.";

    console.log("Original Prompt:", prompt);
    const cleaned = await ai.cleanImagePrompt(prompt);
    console.log("Cleaned Prompt:", cleaned);
}

test().catch(console.error);
