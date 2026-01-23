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
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:59',message:'constructPrompt entry',data:{key:options.key,groupName:options.groupName,groupType:options.groupType,subtype:options.subtype,type:options.type},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.4'})}).catch(()=>{});
        // #endregion

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
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:87',message:'Atlas reference lookup START',data:{key:options.key,lowerKey,lowerLabel},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
            // #endregion
            const asset = await AssetRepository.findByKey('system_coach_atlas_ref');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:90',message:'Atlas reference asset retrieved',data:{key:options.key,hasAsset:!!asset,hasBuffer:!!asset?.buffer,hasValue:!!asset?.value,bufferLength:asset?.buffer?.length||0,valueLength:asset?.value?.length||0,valuePrefix:asset?.value?.substring(0,50)||'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
            // #endregion
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:93',message:'Atlas ref from buffer',data:{key:options.key,refImageLength:refImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
                // #endregion
            } else if (asset?.value) {
                // Value might already be base64 or data URI
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:97',message:'Atlas ref from value',data:{key:options.key,valueIsDataUri:asset.value.startsWith('data:image'),refImageLength:refImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
                // #endregion
            } else {
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:100',message:'Atlas ref NOT FOUND',data:{key:options.key},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
                // #endregion
            }
            refType = 'identity';
        } else if (lowerKey.includes('nova') || lowerLabel.includes('nova')) {
            identity = 'nova';
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:104',message:'Nova reference lookup START',data:{key:options.key,lowerKey,lowerLabel},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
            // #endregion
            const asset = await AssetRepository.findByKey('system_coach_nova_ref');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:107',message:'Nova reference asset retrieved',data:{key:options.key,hasAsset:!!asset,hasBuffer:!!asset?.buffer,hasValue:!!asset?.value,bufferLength:asset?.buffer?.length||0,valueLength:asset?.value?.length||0,valuePrefix:asset?.value?.substring(0,50)||'none'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
            // #endregion
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:110',message:'Nova ref from buffer',data:{key:options.key,refImageLength:refImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
                // #endregion
            } else if (asset?.value) {
                // Value might already be base64 or data URI
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:114',message:'Nova ref from value',data:{key:options.key,valueIsDataUri:asset.value.startsWith('data:image'),refImageLength:refImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
                // #endregion
            } else {
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:117',message:'Nova ref NOT FOUND',data:{key:options.key},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'})}).catch(()=>{});
                // #endregion
            }
            refType = 'identity';
        } else if (groupType === 'exercise') {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:121',message:'Gym background lookup START',data:{key:options.key,groupType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
            // #endregion
            const asset = await AssetRepository.findByKey('system_background_gym_ref');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:124',message:'Gym background asset retrieved',data:{key:options.key,hasAsset:!!asset,hasBuffer:!!asset?.buffer,hasValue:!!asset?.value,bufferLength:asset?.buffer?.length||0,valueLength:asset?.value?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
            // #endregion
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
            } else if (asset?.value) {
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
            }
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:129',message:'Gym background result',data:{key:options.key,hasRefImage:!!refImage,refImageLength:refImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
            // #endregion
            refType = 'environment';
        } else if (groupType === 'meal') {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:133',message:'Kitchen background lookup START',data:{key:options.key,groupType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
            // #endregion
            const asset = await AssetRepository.findByKey('system_background_kitchen_ref');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:136',message:'Kitchen background asset retrieved',data:{key:options.key,hasAsset:!!asset,hasBuffer:!!asset?.buffer,hasValue:!!asset?.value,bufferLength:asset?.buffer?.length||0,valueLength:asset?.value?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
            // #endregion
            if (asset?.buffer) {
                refImage = `data:image/png;base64,${asset.buffer.toString('base64')}`;
            } else if (asset?.value) {
                refImage = asset.value.startsWith('data:image') ? asset.value : `data:image/png;base64,${asset.value}`;
            }
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:141',message:'Kitchen background result',data:{key:options.key,hasRefImage:!!refImage,refImageLength:refImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
            // #endregion
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

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:137',message:'constructPrompt return',data:{key,identity,refType,hasRefImage:!!refImage,refImageLength:refImage?.length||0,promptLength:prompt.length,groupType},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'})}).catch(()=>{});
        // #endregion

        return { prompt, referenceImage: refImage, referenceType: refType };
    }

    static async generateInstructions(name: string, type: 'exercise' | 'meal'): Promise<any> {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:140',message:'generateInstructions entry',data:{name,type},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'})}).catch(()=>{});
        // #endregion

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

        // Retry logic for API overload errors
        let lastError: Error | null = null;
        const maxRetries = 3;
        const retryDelay = 2000; // 2 seconds
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // #region agent log
                if (attempt > 1) {
                    fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:253',message:'generateInstructions retry',data:{name,type,attempt,maxRetries},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'})}).catch(()=>{});
                }
                // #endregion
                
                const res = await ai.generateText({ prompt: fullPrompt });
                const cleaned = cleanJson(res.text);
                const parsed = JSON.parse(cleaned);
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:260',message:'generateInstructions success',data:{name,type,attempt,hasDescription:!!parsed.description,instructionsCount:parsed.instructions?.length||0,hasSafetyWarnings:!!parsed.safety_warnings,safetyWarningsCount:parsed.safety_warnings?.length||0,hasProTips:!!parsed.pro_tips,proTipsCount:parsed.pro_tips?.length||0,hasNutritionScience:!!parsed.nutrition_science,hasPrepTips:!!parsed.prep_tips,prepTipsCount:parsed.prep_tips?.length||0,firstInstructionHasSimple:!!parsed.instructions?.[0]?.simple,firstInstructionHasDetailed:!!parsed.instructions?.[0]?.detailed},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'})}).catch(()=>{});
                // #endregion
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
        
        console.error("[AssetPromptService] Failed to generate instructions after retries:", lastError);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'assetPromptService.ts:278',message:'generateInstructions error after retries',data:{name,type,error:lastError?.message,attempts:maxRetries},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'})}).catch(()=>{});
        // #endregion
        return { description: name, instructions: [] };
    }
}
