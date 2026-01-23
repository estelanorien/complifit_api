import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
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
    coachMaleDescription: "Light-skinned Caucasian athletic male with a short dark buzz cut haircut, slight facial stubble, clean and sharp features. Wearing a dark grey performance t-shirt and black athletic shorts.",
    coachFemaleDescription: "Platinum blonde Caucasian female athlete. High ponytail. Emerald green sports bra and black athletic leggings."
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
            const asset = await AssetRepository.findByKey('system_blueprints');
            if (asset && asset.buffer) {
                const blueprints = JSON.parse(asset.buffer.toString());
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
            backgroundStyle?: string;
        }
    ): Promise<{ prompt: string; referenceImage?: string; referenceType: 'identity' | 'environment' }> {
        const guidelines = await this.getGuidelines();
        const { key, groupName, groupType, subtype, label, type, context, backgroundStyle } = options;

        let style = "";
        let identity: 'atlas' | 'nova' | 'mannequin' | 'none' = 'none';
        let refImage: string | undefined = undefined;
        let refType: 'identity' | 'environment' = 'identity';

        const lowerKey = key.toLowerCase();
        const lowerLabel = (label || "").toLowerCase();

        // 1. Resolve Identity and References
        if (lowerKey.includes('atlas') || lowerLabel.includes('atlas')) {
            identity = 'atlas';
            const asset = await AssetRepository.findByKey('system_coach_atlas_ref');
            refImage = asset?.buffer?.toString() || undefined;
            refType = 'identity';
        } else if (lowerKey.includes('nova') || lowerLabel.includes('nova')) {
            identity = 'nova';
            const asset = await AssetRepository.findByKey('system_coach_nova_ref');
            refImage = asset?.buffer?.toString() || undefined;
            refType = 'identity';
        } else if (groupType === 'exercise') {
            const asset = await AssetRepository.findByKey('system_background_gym_ref');
            refImage = asset?.buffer?.toString() || undefined;
            refType = 'environment';
        } else if (groupType === 'meal') {
            const asset = await AssetRepository.findByKey('system_background_kitchen_ref');
            refImage = asset?.buffer?.toString() || undefined;
            refType = 'environment';
        }

        // 2. Select Style
        if (type === 'video') {
            style = groupType === 'exercise' ? guidelines.styleExerciseVideo : guidelines.styleMealVideo;
        } else {
            if (groupType === 'exercise') {
                style = guidelines.styleExerciseImage;
                if (identity === 'atlas') {
                    style += ` Subject: COACH ATLAS. ${guidelines.coachMaleDescription || "Athletic male, professional gym photography."}`;
                } else if (identity === 'nova') {
                    style += ` Subject: COACH NOVA. ${guidelines.coachFemaleDescription || "Athletic female, professional gym photography."}`;
                } else {
                    style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
                }
            } else if (groupType === 'meal') {
                style = guidelines.styleMealImage;
            }
        }

        // 3. Core Description
        let coreDescription = "";
        if (subtype === 'step') {
            coreDescription = `ACTION: ${label || "Active Movement"}. ${context || "Performing the exercise with perfect form."} Single subject centered shot of ${groupName}.`;
        } else {
            coreDescription = `HERO POSE: ${groupName}. Full body execution. ${context || "Perfect professional form."}`;
        }

        let prompt = `${style}${backgroundStyle ? " ENVIRONMENT: " + backgroundStyle + "." : ""} SUBJECT: ${coreDescription}.`;

        if (groupType === 'meal' && type === 'image') {
            prompt += " CRITICAL: STRICTLY NO TEXT, NO CALORIE LABELS, NO OVERLAYS.";
        } else if (type === 'image') {
            prompt += " STRICTLY NO TEXT.";
        }

        return { prompt, referenceImage: refImage, referenceType: refType };
    }

    static async generateInstructions(name: string, type: 'exercise' | 'meal'): Promise<any> {
        const ai = new AiService();
        const fullPrompt = `You are an expert fitness coach and nutritionist. Generate detailed instructions for the ${type === 'exercise' ? 'exercise' : 'meal'}: "${name}".
        
        REQUIREMENTS:
        - Return ONLY valid JSON.
        - description: One sentence high-level summary.
        - instructions: Array of 6 to 10 steps.
        
        IF EXERCISE:
        - safety_warnings: Array of 3 critical safety tips.
        - pro_tips: Array of 3 performance tips.
        - common_mistakes: Array of 3 mistakes to avoid.
        
        IF MEAL:
        - nutrition_science: A short paragraph explaining the health benefits.
        - prep_tips: Array of 3 preparation tips.
        - allergens: Array of potential allergens.
        
        JSON STRUCTURE:
        {
            "description": "...",
            "instructions": [
                { "label": "...", "detailed": "...", "simple": "..." }
            ],
            "safety_warnings": ["..."],
            "pro_tips": ["..."],
            "common_mistakes": ["..."],
            "nutrition_science": "...",
            "prep_tips": ["..."],
            "allergens": ["..."]
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
