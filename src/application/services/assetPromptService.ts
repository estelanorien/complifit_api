import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { AiService } from './aiService.js';
import { logger } from '../../infra/logger.js';

export interface PromptGuidelines {
    styleExerciseImage: string;
    styleMealImage: string;
    styleExerciseVideo: string;
    styleMealVideo: string;
    style3DAnatomyVideo?: string;
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
    coachMaleDescription: "Light-skinned Caucasian athletic male with a short dark buzz cut haircut, slight facial stubble, clean and sharp features. Wearing a dark grey performance t-shirt, black athletic shorts, and athletic shoes (sports sneakers).",
    coachFemaleDescription: "Platinum blonde Caucasian female athlete. High ponytail. Emerald green sports bra, black athletic leggings, and athletic shoes (sports sneakers)."
};

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
        } catch (e) {
            // Log error but fall back to defaults - not critical
            logger.debug('Failed to load custom guidelines, using defaults', { error: e, location: 'AssetPromptService.getGuidelines' });
        }
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
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
            } else if (asset?.value) {
                // Value might already be base64 or data URI
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
            }
            if (!refImage && type === 'image' && groupType === 'exercise') {
                throw new Error('CRITICAL: Atlas coach reference image (system_coach_atlas_ref) is missing. Upload it in Admin (Refs Status) before generating exercise images. NEVER generate without reference—prevents wrong person (e.g. bald) in output.');
            }
            refType = 'identity';
        } else if (lowerKey.includes('nova') || lowerLabel.includes('nova')) {
            identity = 'nova';
            const asset = await AssetRepository.findByKey('system_coach_nova_ref');
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
            } else if (asset?.value) {
                // Value might already be base64 or data URI
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
            }
            if (!refImage && type === 'image' && groupType === 'exercise') {
                throw new Error('CRITICAL: Nova coach reference image (system_coach_nova_ref) is missing. Upload it in Admin (Refs Status) before generating exercise images. NEVER generate without reference—prevents wrong person (e.g. bald) in output.');
            }
            refType = 'identity';
        } else if (groupType === 'exercise') {
            const asset = await AssetRepository.findByKey('system_background_gym_ref');
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
            } else if (asset?.value) {
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
            }
            refType = 'environment';
        } else if (groupType === 'meal') {
            const asset = await AssetRepository.findByKey('system_background_kitchen_ref');
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
            } else if (asset?.value) {
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
            }
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
                    // ENFORCE: Atlas MUST wear athletic shoes - add explicitly even if description doesn't mention it
                    if (!guidelines.coachMaleDescription?.toLowerCase().includes('shoe') && !guidelines.coachMaleDescription?.toLowerCase().includes('sneaker')) {
                        style += ` Wearing athletic shoes (sports sneakers).`;
                    }
                    // CRITICAL: Lock Atlas outfit for consistent clothing across all generations
                    style += ` OUTFIT LOCK (Atlas): dark grey performance t-shirt, black athletic shorts, athletic shoes (sports sneakers). No hoodie, no jacket, no hat, no gloves. No logos. Do not change outfit colors.`;
                } else if (identity === 'nova') {
                    style += ` Subject: COACH NOVA. ${guidelines.coachFemaleDescription || "Athletic female, professional gym photography."}`;
                    // ENFORCE: Nova MUST wear athletic shoes - add explicitly even if description doesn't mention it
                    if (!guidelines.coachFemaleDescription?.toLowerCase().includes('shoe') && !guidelines.coachFemaleDescription?.toLowerCase().includes('sneaker')) {
                        style += ` Wearing athletic shoes (sports sneakers).`;
                    }
                    // CRITICAL: Lock Nova outfit for consistent clothing across all generations
                    style += ` OUTFIT LOCK (Nova): emerald green sports bra, black athletic leggings, athletic shoes (sports sneakers). No jacket, no hoodie. No logos. Do not change outfit colors.`;
                } else {
                    style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
                }
                // CRITICAL: Always enforce footwear for exercise images - REPEATED for emphasis
                style += ` CRITICAL REQUIREMENT: Subject MUST wear athletic shoes (sports sneakers) at all times. NO barefoot, NO socks only, NO feet visible without shoes. This is MANDATORY and NON-NEGOTIABLE.`;
            } else if (groupType === 'meal') {
                style = guidelines.styleMealImage;
            }
        }

        // 3. Core Description
        let coreDescription = "";
        if (subtype === 'step') {
            if (groupType === 'meal') {
                // For meal steps: emphasize preparation action (chopping, stirring, seasoning, etc.)
                const actionHint = context ? `Chef hands ${context.toLowerCase()}` : "Chef hands actively preparing ingredients";
                coreDescription = `PREPARATION ACTION: ${label || actionHint}. ${context || "Close-up of hands and ingredients during active cooking step."} Professional food photography, in-progress cooking, not finished dish.`;
            } else {
                coreDescription = `ACTION: ${label || "Active Movement"}. ${context || "Performing the exercise with perfect form."} Single subject centered shot of ${groupName}.`;
            }
        } else {
            if (groupType === 'meal') {
                coreDescription = `HERO DISH: ${groupName}. Finished, plated presentation. Professional food photography.`;
            } else {
                coreDescription = `HERO POSE: ${groupName}. Full body execution. ${context || "Perfect professional form."}`;
            }
        }

        let prompt = `${style}${backgroundStyle ? " ENVIRONMENT: " + backgroundStyle + "." : ""} SUBJECT: ${coreDescription}.`;

        if (groupType === 'meal' && type === 'image') {
            prompt += " CRITICAL: STRICTLY NO TEXT, NO CALORIE LABELS, NO OVERLAYS.";
        } else if (type === 'image') {
            prompt += " STRICTLY NO TEXT.";
            // CRITICAL: Always enforce footwear for exercise images (all steps and main) - REPEATED for emphasis
            if (groupType === 'exercise') {
                prompt += " CRITICAL REQUIREMENT: Subject MUST wear athletic shoes (sports sneakers) at all times. NO barefoot, NO socks only, NO feet visible without shoes. This is MANDATORY and NON-NEGOTIABLE. The subject's feet MUST be completely covered by athletic shoes in every image.";
                // CRITICAL: Prevent medical gear (bandages, casts, braces) - the exercise is about movement, not injury treatment
                const hasSprain = /sprain/i.test(groupName) || /sprain/i.test(coreDescription);
                if (hasSprain) {
                    prompt += " ABSOLUTELY NO medical equipment, bandages, casts, braces, or injury treatment devices. This is a fitness exercise demonstration, NOT a medical treatment scenario. The subject is healthy and performing the exercise normally.";
                }
            }
        }

        return { prompt, referenceImage: refImage, referenceType: refType };
    }

    static async generateInstructions(name: string, type: 'exercise' | 'meal', stepCount?: number): Promise<any> {
        const ai = new AiService();
        const stepReq = stepCount != null
            ? `Provide EXACTLY ${stepCount} steps—no more, no fewer.`
            : (type === 'meal' ? 'Provide EXACTLY 8–10 steps.' : 'Provide at least 7, ideally 8–10 steps.');

        // Match user-triggered instruction quality (rerollInstructionText): imperative, coaching, safety per step.
        const fullPrompt = type === 'meal'
            ? `You are a professional chef and nutritionist. Generate recipe details for: "${name}".

CRITICAL: ${stepReq}
Each step MUST have:
- "simple": Single short cue. Max 10 words. No safety sentence. Punchy action (e.g. "Sauté onions until golden", "Fold in cream gently").
- "detailed": Max 3 sentences. 1) Execution detail (imperative, coaching). 2) Chef tip or technique. 3) Very short safety/caution tip for this step (e.g. avoid burns, sharp knives).
Imperative only. No preambles like "Here are the instructions". No step numbers in output. Be specific to THIS meal.

Return JSON:
{
    "description": "A compelling 2-sentence description of this dish",
    "instructions": [
        { "label": "Step title", "simple": "Brief cue, max 10 words", "detailed": "Up to 3 sentences: execution, chef tip, short safety tip for this step." }
    ],
    "nutrition_science": "Health benefits, key nutrients, why this meal is good for you (3-4 sentences)",
    "prep_tips": ["3 professional prep tips for this dish"],
    "allergens": ["Potential allergens"],
    "ingredients": ["Main ingredients"],
    "macros": { "protein": 0, "carbs": 0, "fat": 0 },
    "calories": 0
}`
            : `You are a clinical physical therapist and movement specialist. Generate exercise instructions for: "${name}".

CRITICAL: ${stepReq}
Each step MUST have:
- "simple": Single short cue. Max 10 words. No safety sentence. Punchy action (e.g. "Chest up", "Drive heels", "Squeeze glutes").
- "detailed": Max 3 sentences. 1) Execution detail (imperative, coaching, form cues). 2) Optional form/technique tip. 3) Very short safety tip for this step (how not to get hurt).
Imperative only. No preambles. No step numbers in output. Clinical precision.

Return JSON:
{
    "description": "A compelling description of this exercise and its benefits",
    "instructions": [
        { "label": "Step title", "simple": "2-5 word cue", "detailed": "Up to 3 sentences: execution, form tip, short safety tip for this step." }
    ],
    "safety_warnings": ["3 critical safety considerations"],
    "pro_tips": ["3 performance tips"],
    "common_mistakes": ["3 common mistakes"],
    "target_muscles": ["Primary muscles worked"],
    "equipment": ["Equipment or 'bodyweight'"]
}`;

        // Retry logic for API overload errors
        let lastError: Error | null = null;
        const maxRetries = 3;
        const retryDelay = 2000; // 2 seconds
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await ai.generateText({ 
                    prompt: fullPrompt,
                    generationConfig: { responseMimeType: "application/json" }
                });
                const cleaned = cleanJson(res.text);
                const parsed = JSON.parse(cleaned);
                
                // Validate we got enough steps (stepCount when provided, else >= 6)
                const minSteps = stepCount != null ? stepCount : 6;
                if (!parsed.instructions || parsed.instructions.length < minSteps) {
                    throw new Error(`AI returned insufficient instructions (${parsed.instructions?.length || 0} steps, need ${minSteps})`);
                }
                return parsed;
            } catch (e: any) {
                lastError = e;
                const isOverloadError = e.message?.includes('503') || e.message?.includes('overloaded');
                
                if (isOverloadError && attempt < maxRetries) {
                    // Wait before retrying
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    continue;
                }
                
                // If not overload error or last attempt, break
                if (!isOverloadError || attempt === maxRetries) {
                    break;
                }
            }
        }
        
        // IMPORTANT: Return meaningful fallback instead of empty instructions
        // This ensures text ALWAYS gets saved, even if AI fails
        return this.generateFallbackInstructions(name, type);
    }
    
    /**
     * Generate meaningful fallback instructions when AI is unavailable.
     * These are generic but usable defaults based on the exercise/meal name.
     */
    static generateFallbackInstructions(name: string, type: 'exercise' | 'meal'): any {
        
        const cleanName = name.replace(/_/g, ' ').toLowerCase();
        
        if (type === 'exercise') {
            // Generate generic exercise steps based on common patterns
            const isCardio = /sprint|run|jog|walk|jump|burpee|mountain|skip|hop/i.test(cleanName);
            const isStrength = /press|squat|deadlift|curl|row|push|pull|lift|raise/i.test(cleanName);
            const isStretch = /stretch|yoga|flex|bend|twist/i.test(cleanName);
            
            let steps: any[] = [];
            
            if (isCardio) {
                steps = [
                    { label: "Setup", detailed: `Find a clear, flat space for ${name}. Ensure you have proper footwear.`, simple: "Clear space, proper shoes." },
                    { label: "Warm-up", detailed: "Perform light dynamic stretches - leg swings, arm circles, and light jogging in place for 2-3 minutes.", simple: "Dynamic warm-up 2-3 min." },
                    { label: "Starting Position", detailed: "Stand tall with feet hip-width apart, core engaged, arms ready at your sides.", simple: "Stand tall, core engaged." },
                    { label: "Execute Movement", detailed: `Begin ${name} with controlled intensity. Focus on proper form and breathing.`, simple: "Start with good form." },
                    { label: "Maintain Form", detailed: "Keep your posture upright, breathe rhythmically, and maintain consistent pace.", simple: "Keep posture, breathe steady." },
                    { label: "Cool Down", detailed: "Gradually reduce intensity. Walk for 1-2 minutes to lower heart rate.", simple: "Slow down gradually." }
                ];
            } else if (isStrength) {
                steps = [
                    { label: "Setup", detailed: `Position yourself for ${name}. Check equipment and ensure proper weight selection.`, simple: "Setup equipment safely." },
                    { label: "Starting Position", detailed: "Assume the starting position with proper grip, stance, and core braced.", simple: "Proper grip and stance." },
                    { label: "Initiate Movement", detailed: "Begin the movement with controlled tempo. Focus on the target muscles.", simple: "Start controlled movement." },
                    { label: "Peak Contraction", detailed: "At the top of the movement, squeeze the target muscles briefly.", simple: "Squeeze at the top." },
                    { label: "Controlled Return", detailed: "Lower the weight with control, maintaining tension throughout.", simple: "Lower with control." },
                    { label: "Complete Rep", detailed: "Return to starting position. Reset and prepare for the next repetition.", simple: "Reset for next rep." }
                ];
            } else {
                // Generic exercise steps
                steps = [
                    { label: "Preparation", detailed: `Prepare for ${name}. Clear your space and gather any needed equipment.`, simple: "Prepare your space." },
                    { label: "Starting Position", detailed: "Position your body correctly for the movement. Engage your core.", simple: "Get in position." },
                    { label: "Execute Phase 1", detailed: "Begin the first phase of the movement with proper technique.", simple: "Start the movement." },
                    { label: "Execute Phase 2", detailed: "Continue through the movement pattern with controlled motion.", simple: "Continue with control." },
                    { label: "Complete Movement", detailed: "Finish the movement and return to starting position.", simple: "Return to start." },
                    { label: "Reset", detailed: "Reset your position and prepare for the next repetition.", simple: "Reset and repeat." }
                ];
            }
            
            return {
                description: `${name} - a ${isCardio ? 'cardiovascular' : isStrength ? 'strength' : 'fitness'} exercise for improving overall fitness.`,
                instructions: steps,
                safety_warnings: [
                    "Always warm up before exercising",
                    "Stop if you feel sharp pain",
                    "Stay hydrated throughout"
                ],
                pro_tips: [
                    "Focus on form over speed",
                    "Breathe consistently throughout",
                    "Progress gradually over time"
                ],
                common_mistakes: [
                    "Rushing through repetitions",
                    "Holding your breath",
                    "Ignoring proper form"
                ]
            };
        } else {
            // Meal fallback
            return {
                description: `${name} - a nutritious meal option.`,
                instructions: [
                    { label: "Gather Ingredients", detailed: `Collect all ingredients needed for ${name}.`, simple: "Gather ingredients." },
                    { label: "Prep Work", detailed: "Wash, chop, and measure all ingredients before cooking.", simple: "Prep all ingredients." },
                    { label: "Cook Base", detailed: "Start cooking the main components of the dish.", simple: "Cook main ingredients." },
                    { label: "Combine", detailed: "Combine all ingredients according to the recipe.", simple: "Combine ingredients." },
                    { label: "Season", detailed: "Add seasonings and adjust to taste.", simple: "Season to taste." },
                    { label: "Serve", detailed: "Plate the dish and serve while fresh.", simple: "Plate and serve." }
                ],
                nutrition_science: "This meal provides essential nutrients for a balanced diet.",
                prep_tips: ["Prep ingredients in advance", "Use fresh ingredients when possible", "Season gradually"],
                allergens: ["Check individual ingredients for allergens"]
            };
        }
    }
}
