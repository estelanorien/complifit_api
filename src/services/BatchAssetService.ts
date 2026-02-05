
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

        // --- NEW: PHASE 0 - Placeholder Creation ---
        // Immediate persistence of "generating" state for visual feedback
        // We do this before heavy lifting so frontend sees it immediately

        // We will do this "optimistically" or "just-in-time" during the loop
        // But doing it upfront allows us to report "0/12 assets" immediately.

        // ... (We will add placeholders in the loop or right after definition) 


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

        // 2. Define Phase 1 Assets (Independent: Hero, Refs)
        const phase1Assets: { key: string; type: 'image' | 'video' | 'text'; prompt?: string; label?: string; subtype: 'main' | 'step'; context?: string }[] = [];

        // Hero
        phase1Assets.push({
            key: mainKey, type: 'image', subtype: 'main', label: 'Hero Image',
            context: (mainInstructions as any)?.textContext || groupName
        });

        // Refs (Exercise only)
        const atlasKey = `ex_${movementId}_atlas`;
        const novaKey = `ex_${movementId}_nova`;

        if (groupType === 'exercise') {
            phase1Assets.push({ key: atlasKey, type: 'image', subtype: 'main', label: 'Atlas Reference', context: "Coach Atlas performing the exercise. Keep face and head intact." });
            phase1Assets.push({ key: novaKey, type: 'image', subtype: 'main', label: 'Nova Reference', context: "Coach Nova performing the exercise. Keep face and head intact." });
        }

        const results = { generated: 0, errors: 0, skipped: 0 };

        // Process Phase 1
        for (const asset of phase1Assets) {
            // Update Progress in Job (Optional Implementation)
            // if (options.jobId) await this.reportProgress(options.jobId, results);

            if (!forceRegen) {
                const exists = await this.checkAssetExists(asset.key);
                // CRITICAL FIX: If it's 'generating', we treat it as existing usually, 
                // BUT since we are THE job, we should assume we need to fulfill it unless it's 'active'/'auto'.
                // Ideally checkAssetExists only returns true for COMPLETED assets ('active', 'auto').
                if (exists) { results.skipped++; continue; }
            }

            // PERSISTENCE: Write Placeholder "generating"
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
                // PERSISTENCE: Mark as failed instead of deleting
                await this.cacheAsset(asset.key, '', 'image', 'failed');
            }
        }

        // 3. Prepare Phase 2 Inputs (Load Refs)
        let atlasRef: string | undefined;
        let novaRef: string | undefined;

        if (groupType === 'exercise') {
            const atlasVal = await this.getAssetValue(atlasKey);
            const novaVal = await this.getAssetValue(novaKey);
            if (typeof atlasVal === 'string') atlasRef = atlasVal;
            if (typeof novaVal === 'string') novaRef = novaVal;
        }

        // 4. Define Phase 2 Assets (Steps with Refs)
        const phase2Assets: { key: string; type: 'image'; subtype: 'step'; label: string; context: string; imageInput?: string }[] = [];

        steps.forEach((step: any, idx: number) => {
            const stepNum = idx + 1;

            if (groupType === 'exercise') {
                // Dual Sets for Exercises
                if (atlasRef) {
                    phase2Assets.push({
                        key: `${mainKey}_atlas_step${stepNum}`, type: 'image', subtype: 'step', label: `Atlas Step ${stepNum}`,
                        context: `Coach Atlas: ${step.instruction}. Keep face and head intact and change body positions for training.`,
                        imageInput: atlasRef
                    });
                }
                if (novaRef) {
                    phase2Assets.push({
                        key: `${mainKey}_nova_step${stepNum}`, type: 'image', subtype: 'step', label: `Nova Step ${stepNum}`,
                        context: `Coach Nova: ${step.instruction}. Keep face and head intact and change body positions for training.`,
                        imageInput: novaRef
                    });
                }
                // Fallback or Generic if refs missing? Maybe generic is not needed if we have specific ones.
                // If neither ref exists, maybe fallback to generic?
                if (!atlasRef && !novaRef) {
                    phase2Assets.push({
                        key: `${mainKey}_step${stepNum}`, type: 'image', subtype: 'step', label: `Step ${stepNum}`, context: step.instruction
                    });
                }
            } else {
                // Standard Meal Steps
                phase2Assets.push({
                    key: `${mainKey}_step${stepNum}`, type: 'image', subtype: 'step', label: step.label || `Step ${stepNum}`, context: step.instruction
                });
            }
        });

        // Process Phase 2
        for (const asset of phase2Assets) {
            if (!forceRegen) {
                const exists = await this.checkAssetExists(asset.key);
                if (exists) { results.skipped++; continue; }
            }

            // PERSISTENCE: Write Placeholder
            await this.cacheAsset(asset.key, '', 'image', 'generating');

            // Add "Reference consistency" note to prompt if imageInput is present
            const ctx = asset.imageInput ? `${asset.context} STRICTLY MAINTAIN FACE AND IDENTITY FROM REFERENCE IMAGE.` : asset.context;

            const prompt = await this.constructPrompt(asset, groupName, groupType, 'standard', ctx);
            try {
                await generateAsset({
                    mode: 'image', // All steps are images for now
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
        asset: { subtype: 'main' | 'step'; label?: string; type: 'image' | 'video' | 'text' },
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
            styleMealVideo: "Cinematic 4k food videography, slow motion cooking, delicious steam, chef preparation, moody lighting."
        };

        let style = "";

        if (asset.type === 'video') {
            if (groupType === 'exercise') {
                style = guidelines.styleExerciseVideo;
                if (asset.label?.includes('Atlas')) style += " Featuring Coach Atlas (Tall, Muscular, Male Model).";
                else if (asset.label?.includes('Nova')) style += " Featuring Coach Nova (Fit, Athletic, Female Model).";
            } else {
                style = guidelines.styleMealVideo;
            }
        } else {
            // Image Styles
            if (groupType === 'exercise') {
                style = guidelines.styleExerciseImage;
                style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
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
