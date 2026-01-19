
import { pool } from '../../infra/db/pool.js';
import { generateAsset } from '../../services/AssetGenerationService.js';

export interface PromptGuidelines {
    styleExerciseImage: string;
    styleMealImage: string;
    styleExerciseVideo: string;
    styleMealVideo: string;
    vitalityAvatarDescription: string;
    coachMaleDescription: string;
    coachFemaleDescription: string;
}

export const DEFAULT_GUIDELINES: PromptGuidelines = {
    styleExerciseImage: "Cinematic fitness photography. High contrast, dramatic lighting, professional gym environment, 8k resolution, highly detailed. Realistic skin textures and sweat. No text.",
    styleMealImage: "Hyperrealistic food photography. 8k resolution, highly detailed, delicious presentation, soft studio lighting, shallow depth of field. CRITICAL: NO TEXT, NO CALORIE LABELS, NO NUTRITION INFO, NO OVERLAYS.",
    vitalityAvatarDescription: "Athletic Mannequin figure. Faceless, featureless face. Bald head. Neutral metallic grey skin tone. Wearing solid Emerald Green athletic shorts and Slate Grey top. No text, no logos.",
    styleExerciseVideo: "Cinematic 4k fitness shot, dark gym, moody lighting, slow motion execution.",
    style3DAnatomyVideo: "3D anatomical render of [Subject]. Transparent biological skin, glowing emerald green muscle highlights on [Target Muscles]. Neutral studio background. Seamless loop motion. 4k resolution, high frame rate.",
    styleMealVideo: "Cinematic 4k food videography, slow motion cooking, delicious steam, chef preparation, moody lighting.",
    coachMaleDescription: "28-year-old Caucasian male, short faded dark-blonde hair, clean shaven, athletic build, grey t-shirt.",
    coachFemaleDescription: "28-year-old Caucasian female, long blonde hair in high ponytail, athletic build, black tank top."
} as any;

function cleanJson(str: string): string {
    if (!str) return "";
    let clean = str.trim();
    if (clean.startsWith("```json")) {
        clean = clean.replace(/^```json/, "").replace(/```$/, "");
    } else if (clean.startsWith("```")) {
        clean = clean.replace(/^```/, "").replace(/```$/, "");
    }
    return clean.trim();
}

export class AssetPromptService {

    static normalizeToId(name: string): string {
        if (!name) return 'unknown';
        let clean = name.toLowerCase().trim();
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        // CRITICAL: No sorting.
        const words = clean.split(' ').filter(w => w.length > 0);
        return words.join('_');
    }

    static async getGuidelines(): Promise<PromptGuidelines> {
        try {
            const res = await pool.query(`SELECT value FROM cached_assets WHERE key = 'system_blueprints'`);
            if (res.rows.length > 0) {
                const blueprints = JSON.parse(res.rows[0].value);
                return blueprints.guidelines || DEFAULT_GUIDELINES;
            }
        } catch (e) { }
        return DEFAULT_GUIDELINES;
    }

    static async generateInstructions(groupName: string, groupType: 'exercise' | 'meal') {
        const prompt = `
            Write instructions for ${groupType}: "${groupName}".
            Return JSON: { 
                "textContext": "Detailed Description of execution", 
                "textContextSimple": "Short Cue", 
                "steps": [{ "label": "Step 1", "instruction": "..." }], 
                "nutritionTips": ["..."] 
            }
            
            REQUIREMENT: 
            1. Provide a detailed breakdown with 8 to 10 steps.
            2. For exercises, focus on exact motor control. For meals, focus on culinary technique.
            3. Detailed steps must be 2-3 sentences long.
        `;
        try {
            const jsonStr = await generateAsset({ mode: 'json', prompt: prompt });
            if (jsonStr) {
                const clean = cleanJson(jsonStr);
                return JSON.parse(clean);
            }
        } catch (e) { console.error("Instruction Gen Failed", e); }
        return { textContext: groupName, textContextSimple: groupName, steps: [] };
    }

    static async constructPrompt(
        options: {
            key: string;
            groupName: string;
            groupType: 'exercise' | 'meal';
            subtype: 'main' | 'step';
            label?: string;
            type: 'image' | 'video' | 'json';
            context?: string;
        }
    ): Promise<string> {
        const guidelines = await this.getGuidelines();
        const { key, groupName, groupType, subtype, label, type, context } = options;

        let style = "";
        let identity = 'mannequin';

        const lowerKey = key.toLowerCase();
        const lowerLabel = (label || "").toLowerCase();

        if (lowerKey.includes('atlas') || lowerLabel.includes('atlas')) {
            identity = 'atlas';
        } else if (lowerKey.includes('nova') || lowerLabel.includes('nova')) {
            identity = 'nova';
        }

        if (type === 'video') {
            if (groupType === 'exercise') {
                style = guidelines.styleExerciseVideo;
                if (identity === 'atlas') style += ` Featuring Coach Atlas (${guidelines.coachMaleDescription}).`;
                else if (identity === 'nova') style += ` Featuring Coach Nova (${guidelines.coachFemaleDescription}).`;
            } else {
                style = guidelines.styleMealVideo;
            }
        } else {
            // Image Styles
            if (groupType === 'exercise') {
                style = guidelines.styleExerciseImage;
                if (identity === 'atlas') {
                    style += ` FEATURING COACH ATLAS: ${guidelines.coachMaleDescription}. STRICTLY clean shaven. Maintain identical facial features to reference. system_coach_atlas_ref`;
                } else if (identity === 'nova') {
                    // CRITICAL: Explicitly mention professional headshot reference to avoid safety blocks
                    style += ` FEATURING COACH NOVA: ${guidelines.coachFemaleDescription}. Using professional headshot reference. Maintain identical facial features to reference. system_coach_nova_ref`;
                } else {
                    style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
                }
            } else if (groupType === 'meal') {
                style = guidelines.styleMealImage;
            }
        }

        let coreDescription = `${groupName}`;
        if (subtype === 'step') {
            coreDescription = `${groupName}, Step: ${label || "Action"}. ${context || ""}`;
        } else {
            coreDescription = `${groupName}. ${context || "Perfect execution."}`;
        }

        let prompt = `${style} SUBJECT: ${coreDescription}.`;

        if (groupType === 'meal' && type === 'image') {
            prompt += " CRITICAL: STRICTLY NO TEXT, NO CALORIE LABELS, NO NUMBERS, NO OVERLAYS, NO NUTRITION INFO.";
        } else if (type === 'image') {
            prompt += " STRICTLY NO TEXT.";
        }

        return prompt;
    }
}
