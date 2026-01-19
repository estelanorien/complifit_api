
import { pool } from '../infra/db/pool.js';
import { generateAsset } from './AssetGenerationService.js';
import { env } from '../config/env.js';

interface GroupAssetGenOptions {
    groupId: string;
    groupName: string;
    groupType: 'exercise' | 'meal';
    forceRegen?: boolean;
    themeId?: string;
    targetStatus?: 'auto' | 'draft' | 'active';
}

interface GroupAssetGenOptions {
    groupId: string;
    groupName: string;
    groupType: 'exercise' | 'meal';
    forceRegen?: boolean;
    themeId?: string;
    targetStatus?: 'auto' | 'draft' | 'active';
    jobId?: string; // Optional: If running inside a job context for progress reporting
}

function cleanJson(str: string): string {
    if (!str) return "";
    // Remove markdown backticks if present
    let clean = str.trim();
    if (clean.startsWith("```json")) {
        clean = clean.replace(/^```json/, "").replace(/```$/, "");
    } else if (clean.startsWith("```")) {
        clean = clean.replace(/^```/, "").replace(/```$/, "");
    }
    return clean.trim();
}

// Add progress reporting interface
interface GenerationResult {
    generated: number;
    errors: number;
    skipped: number;
    total: number;
}


export class BatchAssetService {

    /**
     * Generates all missing assets for a specific group (Exercise or Meal)
     * This moves the heavy lifting to the server to prevent browser crashes.
     */
    static async generateGroupAssets(options: GroupAssetGenOptions) {
        console.log(`[Batch] Starting Group Generation for ${options.groupName} (${options.groupId})`);
        const { groupName, groupType, forceRegen, targetStatus = 'auto' } = options;
        const movementId = this.normalizeToId(groupName);

        // 1. Instructions & Text (Pre-requisite)
        const mainKey = groupType === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;
        let mainInstructions = await this.getAssetValue(`${mainKey}_meta`);
        if (!mainInstructions || forceRegen) {
            const instructions = await this.generateInstructions(groupName, groupType, 'main');
            if (instructions) {
                await this.cacheAsset(`${mainKey}_meta`, JSON.stringify(instructions), 'json');
                mainInstructions = instructions;
            }
        }
        let steps = (mainInstructions as any)?.steps || [];
        if (!steps || steps.length === 0) {
            steps = await this.generateStepBreakdown(groupName, groupType);
            if (mainInstructions && typeof mainInstructions === 'object') {
                (mainInstructions as any).steps = steps;
                await this.cacheAsset(`${mainKey}_meta`, JSON.stringify(mainInstructions), 'json');
            }
        }

        // 2. Define Assets
        const phase1Assets: { key: string; type: 'image' | 'video' | 'text'; prompt?: string; label?: string; subtype: 'main' | 'step'; context?: string }[] = [];
        const phase2Assets: { key: string; type: 'image'; subtype: 'step'; label: string; context: string; imageInput?: string }[] = [];

        // --- EXERCISE ASSETS ---
        if (groupType === 'exercise') {
            const mainKey = `ex_${movementId}`;
            const contextData = mainInstructions as any;

            // 1. Atlas & Nova Hero Assets (Dual Generation)
            phase1Assets.push({
                key: `ex_${movementId}_atlas_main`,
                type: 'image', subtype: 'main', label: 'Atlas Hero',
                context: `${groupName} performed by Coach Atlas.`
            });
            phase1Assets.push({
                key: `ex_${movementId}_nova_main`,
                type: 'image', subtype: 'main', label: 'Nova Hero',
                context: `${groupName} performed by Coach Nova.`
            });

            // 3. Instruction Steps (Dual Generation)
            // Use generating breakdown or fallback
            // IMPORTANT: We use the `steps` variable we ensured exists above.
            const stepCount = steps.length > 0 ? steps.length : 6;

            for (let i = 1; i <= stepCount; i++) {
                const instrText = steps[i - 1]?.instruction || `Step ${i} of ${groupName}.`;

                // Atlas Step
                phase2Assets.push({
                    key: `ex_${movementId}_atlas_step_${i}`,
                    type: 'image', subtype: 'step', label: `Atlas Step ${i}`,
                    context: `Coach Atlas: ${instrText}. Keep face and head intact and change body positions for training.`
                });

                // Nova Step
                phase2Assets.push({
                    key: `ex_${movementId}_nova_step_${i}`,
                    type: 'image', subtype: 'step', label: `Nova Step ${i}`,
                    context: `Coach Nova: ${instrText}. Keep face and head intact and change body positions for training.`
                });
            }
        } else { // MEAL ASSETS
            const mainKey = `meal_${movementId}`;
            // Hero
            phase1Assets.push({
                key: `${mainKey}_main`, type: 'image', subtype: 'main', label: 'Hero Image',
                context: (mainInstructions as any)?.textContext || groupName
            });

            // Standard Meal Steps
            if (steps.length === 0) {
                for (let i = 1; i <= 6; i++) {
                    phase2Assets.push({
                        key: `${mainKey}_step_${i}`,
                        type: 'image', subtype: 'step', label: `Step ${i}`,
                        context: `Step ${i} of preparing ${groupName}`
                    });
                }
            } else {
                steps.forEach((step: any, idx: number) => {
                    const stepNum = idx + 1;
                    phase2Assets.push({
                        key: `${mainKey}_step_${stepNum}`, type: 'image', subtype: 'step', label: step.label || `Step ${stepNum}`, context: step.instruction
                    });
                });
            }
        }

        const results = { generated: 0, errors: 0, skipped: 0 };

        // Process Phase 1 (Heroes)
        for (const asset of phase1Assets) {
            if (!forceRegen) {
                const exists = await this.checkAssetExists(asset.key);
                if (exists) { results.skipped++; continue; }
            }
            await this.cacheAsset(asset.key, '', 'image', 'generating');
            const prompt = await this.constructPrompt(asset, groupName, groupType, 'standard', asset.context);
            try {
                await generateAsset({
                    mode: asset.type === 'text' ? 'json' : asset.type as any,
                    prompt, key: asset.key, status: targetStatus, movementId
                });
                results.generated++;
            } catch (e) {
                console.error(`[Batch] Failed to generate ${asset.key}:`, e);
                results.errors++;
                await this.cacheAsset(asset.key, '', 'image', 'failed');
            }
        }

        // Process Phase 2 (Steps)
        for (const asset of phase2Assets) {
            if (!forceRegen) {
                const exists = await this.checkAssetExists(asset.key);
                if (exists) { results.skipped++; continue; }
            }
            await this.cacheAsset(asset.key, '', 'image', 'generating');
            // Using prompt injection for reference, so imageInput is optional/unused here unless we pipe logic later
            const prompt = await this.constructPrompt(asset, groupName, groupType, 'standard', asset.context);
            try {
                await generateAsset({
                    mode: 'image',
                    prompt, key: asset.key, status: targetStatus, movementId,
                    imageInput: asset.imageInput
                });
                results.generated++;
            } catch (e) {
                console.error(`[Batch] Failed to generate ${asset.key}:`, e);
                results.errors++;
                await this.cacheAsset(asset.key, '', 'image', 'failed');
            }
        }

        return results;
    }




    /**
     * Finds movements that lay 'active' assets (either main video/image or meal steps)
     * and queues them for generation. For now, it runs synchronously for simplicity.
     */
    static async runNightlyBatch() {
        console.log("Starting Nightly Batch Asset Generation...");

        const report = {
            generated: 0,
            errors: 0,
            skipped: 0
        };

        // A. Exercises
        const exerciseRows = await pool.query(
            `SELECT id, name FROM training_exercises WHERE name IS NOT NULL AND name != ''`
        );

        for (const row of exerciseRows.rows) {
            const normalizedId = this.normalizeToId(row.name);
            await this.syncExerciseVideos(row.id, row.name, normalizedId);
        }

        // B. Meals
        const mealRows = await pool.query(`SELECT id, name FROM meals`);
        for (const row of mealRows.rows) {
            await this.syncMealVideos(row.id, row.name, this.normalizeToId(row.name));
        }

        console.log("Nightly Batch Complete (Sync Only)", report);
        return report;
    }

    // --- SYNC HELPERS ---

    private static async syncExerciseVideos(dbId: string, name: string, normalizedId: string) {
        // Sync Main Image
        const mainImageKey = `ex_${normalizedId}`;
        const mainImage = await this.getAssetValue(mainImageKey);

        // Sync Videos if present (Atlas/Nova)
        const atlasKey = `video_exercise_${normalizedId}_atlas`;
        const novaKey = `video_exercise_${normalizedId}_nova`;

        const [atlasUrl, novaUrl] = await Promise.all([
            this.getAssetValue(atlasKey),
            this.getAssetValue(novaKey)
        ]);

        // If we have data, try to update columns if they exist.
        // Assuming columns exist. If not, this query might fail or do nothing if careful.
        // We use COALESCE to keep existing if null.

        if (atlasUrl || novaUrl) {
            await pool.query(
                `UPDATE training_exercises SET video_atlas = COALESCE($1, video_atlas), video_nova = COALESCE($2, video_nova) WHERE name = $3`,
                [atlasUrl, novaUrl, name]
            );
        }

        // If we have a main image, and there's a column for it (e.g. image_url), update it.
        // We'll check if image_url exists in a separate logic or just try.
        // For now, let's assume video syncing is the priority.
    }

    private static async syncMealVideos(dbId: string, name: string, normalizedId: string) {
        // Sync Meal Steps
        // Key format: meal_{id}_step{i}

        const stepMap: Record<string, string> = {};
        for (let i = 1; i <= 10; i++) {
            const key = `meal_${normalizedId}_step${i}`;
            const val = await this.getAssetValue(key);
            if (val && typeof val === 'string') {
                stepMap[i.toString()] = val;
            }
        }

        if (Object.keys(stepMap).length > 0 && dbId) {
            await pool.query(
                `UPDATE meals SET step_videos = $1 WHERE id = $2`,
                [JSON.stringify(stepMap), dbId]
            );
        }
    }


    // --- GEN HELPERS ---



    private static async generateInstructions(groupName: string, groupType: string, type: string) {
        // Generate logic using Gemini JSON
        const prompt = `
            Write instructions for ${groupType}: "${groupName}".
            Return JSON: { "textContext": "Detailed Description of execution", "textContextSimple": "Short Cue", "steps": [{ "label": "Step 1", "instruction": "..." }], "nutritionTips": ["..."] }
            
            REQUIREMENT: 
            1. Provide a detailed breakdown with 8 to 10 steps.
            2. Include a "nutritionTips" array with 3 clinical science tips.
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

    private static async generateStepBreakdown(groupName: string, groupType: string) {
        const prompt = `
            Break down the ${groupType}: "${groupName}" into a step-by-step guide (8-10 steps).
            Return JSON array: [{ "label": "Step Name", "instruction": "Detail (2-3 sentences)" }]
        `;
        try {
            const jsonStr = await generateAsset({ mode: 'json', prompt: prompt });
            if (jsonStr) {
                const clean = cleanJson(jsonStr);
                return JSON.parse(clean);
            }
        } catch (e) { return []; }
        return [];
    }

    private static async constructPrompt(
        asset: { key: string; subtype: 'main' | 'step'; label?: string; type: 'image' | 'video' | 'text' },
        groupName: string,
        groupType: 'exercise' | 'meal',
        mode: string,
        context?: string
    ): Promise<string> {
        // Hardcoded Guidelines (sync with adminService.ts)
        const guidelines = {
            styleExerciseImage: "Cinematic fitness photography. High contrast, dramatic lighting, professional gym environment, 8k resolution, highly detailed. Realistic skin textures and sweat. No text.",
            styleMealImage: "Hyperrealistic food photography. 8k resolution, highly detailed, delicious presentation, soft studio lighting, shallow depth of field. CRITICAL: NO TEXT, NO CALORIE LABELS, NO NUTRITION INFO, NO OVERLAYS.",
            vitalityAvatarDescription: "Athletic Mannequin figure. Faceless, featureless face. Bald head. Neutral metallic grey skin tone. Wearing solid Emerald Green athletic shorts and Slate Grey top.",
            styleExerciseVideo: "Cinematic 4k fitness shot, dark gym, moody lighting, slow motion execution. Perfect form.",
            styleMealVideo: "Cinematic 4k food videography, slow motion cooking, delicious steam, chef preparation, moody lighting.",
            coachMaleDescription: "28-year-old Caucasian male, short faded dark-blonde hair, clean shaven, athletic build, grey t-shirt.",
            coachFemaleDescription: "28-year-old Caucasian female, long blonde hair in high ponytail, athletic build, black tank top."
        };

        let style = "";
        let identity = 'mannequin'; // Default identity

        const lowerKey = asset.key.toLowerCase();
        const lowerLabel = asset.label?.toLowerCase() || "";

        if (lowerKey.includes('atlas') || lowerLabel.includes('atlas')) {
            identity = 'atlas';
        } else if (lowerKey.includes('nova') || lowerLabel.includes('nova')) {
            identity = 'nova';
        }

        if (asset.type === 'video') {
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
                    style += ` FEATURING COACH NOVA: ${guidelines.coachFemaleDescription}. Maintain identical facial features to reference. system_coach_nova_ref`;
                } else {
                    style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
                }
            } else if (groupType === 'meal') {
                style = guidelines.styleMealImage;
            }
        }

        let coreDescription = `${groupName}`;
        if (asset.subtype === 'step') {
            coreDescription = `${groupName}, Step: ${asset.label || "Action"}. ${context || ""}`;
        } else {
            coreDescription = `${groupName}. ${context || "Perfect execution."}`;
        }

        let prompt = `${style} SUBJECT: ${coreDescription}.`;

        if (groupType === 'meal' && asset.type === 'image') {
            prompt += " CRITICAL: STRICTLY NO TEXT, NO CALORIE LABELS, NO NUMBERS, NO OVERLAYS, NO NUTRITION INFO.";
        } else if (asset.type === 'image') {
            prompt += " STRICTLY NO TEXT.";
        }

        return prompt;
    }

    // --- DB HELPERS ---

    private static async cacheAsset(key: string, value: string, type: 'json' | 'image' | 'video', status: string = 'auto') {
        const safeStatus = ['active', 'draft', 'auto', 'generating', 'failed', 'rejected'].includes(status) ? status : 'auto';
        await pool.query(
            `INSERT INTO cached_assets(key, value, asset_type, status)
             VALUES($1, $2, $3, $4)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status`,
            [key, value, type, safeStatus]
        );
    }

    private static async getAssetValue(key: string): Promise<string | object | null> {
        const res = await pool.query(`SELECT value, asset_type FROM cached_assets WHERE key=$1`, [key]);
        if (res.rows.length === 0) return null;
        if (res.rows[0].asset_type === 'json') {
            try { return JSON.parse(res.rows[0].value); } catch (e) { return null; }
        }
        return res.rows[0].value;
    }

    private static normalizeToId(name: string): string {
        if (!name) return 'unknown';
        let clean = name.toLowerCase().trim();
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        const words = clean.split(' ').filter(w => w.length > 0).sort();
        return words.join('_');
    }

    private static async checkAssetExists(key: string): Promise<boolean> {
        const res = await pool.query(
            `SELECT status, updated_at FROM cached_assets WHERE key=$1`,
            [key]
        );
        if (res.rowCount === 0) return false;

        const { status, updated_at } = res.rows[0];

        // If it's active/auto, it exists.
        if (['active', 'auto'].includes(status)) return true;

        // If it's 'generating', check if it's stale (> 10 mins)
        if (status === 'generating') {
            const isStale = new Date().getTime() - new Date(updated_at).getTime() > 10 * 60 * 1000;
            return !isStale; // If NOT stale, it exists (is being processed). If stale, treat as NOT existing.
        }

        // 'failed' or others: Treat as NOT existing so we can retry
        return false;
    }
}
