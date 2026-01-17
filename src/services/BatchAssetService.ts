
import { pool } from '../infra/db/pool.js';
import { generateAsset } from './AssetGenerationService.js';
import { env } from '../config/env.js';

interface GroupAssetGenOptions {
    groupId: string;
    groupName: string;
    groupType: 'exercise' | 'meal';
    forceRegen?: boolean;
    themeId?: string;
}

export class BatchAssetService {

    /**
     * Generates all missing assets for a specific group (Exercise or Meal)
     * This moves the heavy lifting to the server to prevent browser crashes.
     */
    static async generateGroupAssets(options: GroupAssetGenOptions) {
        console.log(`[Batch] Starting Group Generation for ${options.groupName} (${options.groupId})`);
        const { groupName, groupType, forceRegen } = options;
        const movementId = this.normalizeToId(groupName);

        // 1. Determine Assets Needed
        const assetsToGenerate: { key: string; type: 'image' | 'video' | 'text'; prompt?: string; label?: string; subtype: 'main' | 'step'; context?: string }[] = [];

        // Main Asset
        const mainKey = groupType === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;

        // Check if Text Exists (Instructions) - if not, generate text first
        let mainInstructions = await this.getAssetValue(`${mainKey}_meta`); // We store json meta here
        if (!mainInstructions || forceRegen) {
            const instructions = await this.generateInstructions(groupName, groupType, 'main');
            if (instructions) {
                await this.cacheAsset(`${mainKey}_meta`, JSON.stringify(instructions), 'json');
                mainInstructions = instructions; // Use for prompt context
            }
        }

        // Add Main Image to Queue
        assetsToGenerate.push({
            key: mainKey,
            type: 'image',
            subtype: 'main',
            label: 'Hero Image',
            context: (mainInstructions as any)?.textContext || groupName
        });


        // Steps Assets (Heuristic: 3-5 steps if not defined)
        let steps = (mainInstructions as any)?.steps || [];
        if (!steps || steps.length === 0) {
            steps = await this.generateStepBreakdown(groupName, groupType);
            // Save updated meta
            if (mainInstructions && typeof mainInstructions === 'object') {
                (mainInstructions as any).steps = steps;
                await this.cacheAsset(`${mainKey}_meta`, JSON.stringify(mainInstructions), 'json');
            }
        }

        steps.forEach((step: any, idx: number) => {
            const stepNum = idx + 1;
            const stepKey = `${mainKey}_step${stepNum}`;
            assetsToGenerate.push({
                key: stepKey,
                type: 'image',
                subtype: 'step',
                label: step.label || `Step ${stepNum}`,
                context: step.instruction
            });
        });

        // 2. Process Queue
        const results = { generated: 0, errors: 0, skipped: 0 };

        for (const asset of assetsToGenerate) {
            // Check existence
            if (!forceRegen) {
                const exists = await this.checkAssetExists(asset.key);
                if (exists) {
                    results.skipped++;
                    continue;
                }
            }

            // Construct Prompt
            const prompt = await this.constructPrompt(asset, groupName, groupType, 'standard', asset.context);

            try {
                // Generate (Sequential to be safe, but server can handle more)
                await generateAsset({
                    mode: asset.type === 'text' ? 'json' : asset.type as any, // 'image' or 'video'
                    prompt,
                    key: asset.key, // This maps to the raw key e.g. ex_pushups_step1
                    status: 'active',
                    movementId
                });
                results.generated++;
                // Small delay to be nice to API
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                console.error(`[Batch] Failed to generate ${asset.key}:`, e);
                results.errors++;
            }
        }

        // 3. Sync to Tables (Critical for App visibility)
        if (groupType === 'exercise') {
            await this.syncExerciseVideos(options.groupId, groupName, movementId);
        } else {
            await this.syncMealVideos(options.groupId, groupName, movementId);
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

    private static async constructPrompt(
        asset: { subtype: 'main' | 'step'; label?: string; },
        groupName: string,
        groupType: 'exercise' | 'meal',
        mode: string,
        context?: string
    ): Promise<string> {
        // Hardcoded Guidelines (sync with adminService.ts)
        const guidelines = {
            styleExerciseImage: "Cinematic fitness photography. High contrast, dramatic lighting, professional gym environment, 8k resolution, highly detailed. Realistic skin textures and sweat. No text.",
            styleMealImage: "Hyperrealistic food photography. 8k resolution, highly detailed, delicious presentation, soft studio lighting, shallow depth of field. CRITICAL: NO TEXT, NO CALORIE LABELS, NO NUTRITION INFO, NO OVERLAYS.",
            vitalityAvatarDescription: "Athletic Mannequin figure. Faceless, featureless face. Bald head. Neutral metallic grey skin tone. Wearing solid Emerald Green athletic shorts and Slate Grey top."
        };

        let style = "";
        if (groupType === 'exercise') {
            style = guidelines.styleExerciseImage;
            // Default to Avatar if no coach specified
            style += ` Featuring: ${guidelines.vitalityAvatarDescription}.`;
        } else if (groupType === 'meal') {
            style = guidelines.styleMealImage;
        }

        let coreDescription = `${groupName}`;
        if (asset.subtype === 'step') {
            coreDescription = `${groupName}, Step: ${asset.label || "Action"}. ${context || ""}`;
        } else {
            coreDescription = `${groupName}. ${context || "Perfect form execution."}`;
        }

        let prompt = `${style} SUBJECT: ${coreDescription}.`;

        if (groupType === 'meal') {
            prompt += " CRITICAL: STRICTLY NO TEXT, NO CALORIE LABELS, NO NUMBERS, NO OVERLAYS, NO NUTRITION INFO.";
        } else {
            prompt += " STRICTLY NO TEXT.";
        }

        return prompt;
    }

    private static async generateInstructions(groupName: string, groupType: string, type: string) {
        // Generate logic using Gemini JSON
        const prompt = `
            Write instructions for ${groupType}: "${groupName}".
            Return JSON: { "textContext": "Detailed Description of execution", "textContextSimple": "Short Cue", "steps": [{ "label": "Step 1", "instruction": "..." }] }
        `;
        try {
            const jsonStr = await generateAsset({ mode: 'json', prompt: prompt }); // We don't cache this raw result, we parse it
            if (jsonStr) return JSON.parse(jsonStr);
        } catch (e) { console.error("Instruction Gen Failed", e); }
        return { textContext: groupName, textContextSimple: groupName, steps: [] };
    }

    private static async generateStepBreakdown(groupName: string, groupType: string) {
        const prompt = `
            Break down the ${groupType}: "${groupName}" into a step-by-step guide (3-6 steps).
            Return JSON array: [{ "label": "Step Name", "instruction": "Detail" }]
        `;
        try {
            const jsonStr = await generateAsset({ mode: 'json', prompt: prompt });
            if (jsonStr) return JSON.parse(jsonStr);
        } catch (e) { return []; }
        return [];
    }

    // --- DB HELPERS ---

    private static async cacheAsset(key: string, value: string, type: 'json' | 'image') {
        await pool.query(
            `INSERT INTO cached_assets(key, value, asset_type, status)
             VALUES($1, $2, $3, 'active')
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
            [key, value, type]
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
            `SELECT 1 FROM cached_assets WHERE key=$1 AND status IN ('active', 'auto')`,
            [key]
        );
        return (res.rowCount || 0) > 0;
    }
}
