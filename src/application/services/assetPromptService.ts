
import { pool } from '../../infra/db/pool.js';
import { generateAsset } from '../../services/AssetGenerationService.js';
import { AiService } from './aiService.js';

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
    coachMaleDescription: "Bald Caucasian male athlete. No hair. Clean shaven.",
    coachFemaleDescription: "Platinum blonde Caucasian female athlete. High ponytail. Emerald green sports bra."
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
                if (identity === 'atlas') style += ` Subject: Coach Atlas.`;
                else if (identity === 'nova') style += ` Subject: Coach Nova.`;
            } else {
                style = guidelines.styleMealVideo;
            }
        } else {
            // Image Styles
            if (groupType === 'exercise') {
                style = guidelines.styleExerciseImage;
                if (identity === 'atlas') {
                    // MINIMAL DESCRIPTION TO AVOID OVERRIDING REFERENCE
                    style += ` Subject: COACH ATLAS (Bald Caucasian Athlete from reference image). STRICTLY BALD. NO HAIR. NO BEARD.`;
                } else if (identity === 'nova') {
                    style += ` Subject: COACH NOVA (Blonde Caucasian Athlete from reference image). Platinum blonde high ponytail. Emerald green sports bra.`;
                } else {
                    style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
                }
            } else if (groupType === 'meal') {
                style = guidelines.styleMealImage;
            }
        }

        let coreDescription = "";
        if (subtype === 'step') {
            coreDescription = `Single subject centered athletic shot. ${groupName}, Step: ${label || "Action"}. ${context || ""}`;
        } else {
            coreDescription = `Single subject centered. ${groupName} full body athletic hero pose. ${context || "Perfect execution."}`;
        }

        let prompt = `${style} SUBJECT: ${coreDescription}.`;

        if (groupType === 'meal' && type === 'image') {
            prompt += " CRITICAL: STRICTLY NO TEXT, NO CALORIE LABELS, NO NUMBERS, NO OVERLAYS, NO NUTRITION INFO.";
        } else if (type === 'image') {
            prompt += " STRICTLY NO TEXT.";
        }

        return prompt;
    }

    static async generateInstructions(name: string, type: 'exercise' | 'meal'): Promise<any> {
        const ai = new AiService();
        const fullPrompt = `You are an expert fitness coach and nutritionist. Generate detailed instructions for the ${type === 'exercise' ? 'exercise' : 'meal'}: "${name}".
        
        REQUIREMENTS:
        - Return ONLY valid JSON.
        - description: One sentence high-level summary.
        - instructions: Array of 6 steps. Each step object has:
            "label": "Short name (e.g. Setup, Launch, Catch)",
            "detailed": "Full sentence instruction (2-3 sentences)",
            "simple": "Short 3-5 word cue (e.g. Keep back straight)"
        
        JSON STRUCTURE:
        {
            "description": "...",
            "instructions": [
                { "label": "...", "detailed": "...", "simple": "..." },
                ...
            ]
        }`;

        try {
            const res = await ai.generateText({ prompt: fullPrompt });
            const cleaned = cleanJson(res.text);
            return JSON.parse(cleaned);
        } catch (e) {
            console.error("[AssetPromptService] Failed to generate instructions:", e);
            return { description: name, instructions: [] };
        }
    }
}
