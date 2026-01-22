
import { pool } from '../infra/db/pool.js';
import { generateAsset } from './AssetGenerationService.js';
import { AssetPromptService } from '../application/services/assetPromptService.js';
import { TranslationService } from './TranslationService.js';
import { AiService } from '../application/services/aiService.js';

// Helper to generate instruction text via AI
async function generateInstructionText(
    groupName: string,
    stepLabel: string,
    groupType: 'exercise' | 'meal',
    outputType: 'detailed' | 'simple'
): Promise<string> {
    const ai = new AiService();

    let prompt = '';
    if (groupType === 'exercise') {
        if (outputType === 'detailed') {
            prompt = `Generate 2 sentences for exercise "${groupName}" - Step: "${stepLabel}".
            Sentence 1: Clear execution instruction (how to perform this movement).
            Sentence 2: Safety tip to prevent injury.
            Use imperative coaching style. No preambles. No step numbers.
            Example: "Drive through your heels and squeeze glutes at the top. Keep your spine neutral to protect your lower back."`;
        } else {
            prompt = `Generate a single short coaching cue (max 8 words) for exercise "${groupName}" - Step: "${stepLabel}".
            Imperative style. No step numbers. No safety tips.
            Example: "Drive through heels, squeeze glutes"`;
        }
    } else {
        if (outputType === 'detailed') {
            prompt = `Generate 2 sentences for meal preparation "${groupName}" - Step: "${stepLabel}".
            Sentence 1: Clear preparation technique.
            Sentence 2: Nutrition science tip or food safety tip.
            Example: "Sear the chicken on high heat until golden brown. High-quality protein supports muscle recovery and satiety."`;
        } else {
            prompt = `Generate a single short cooking tip (max 8 words) for meal "${groupName}" - Step: "${stepLabel}".
            No step numbers.
            Example: "Sear on high heat for crispiness"`;
        }
    }

    try {
        const result = await ai.generateText({ prompt });
        return result?.text?.trim() || '';
    } catch (e) {
        console.error(`[Batch] Failed to generate ${outputType} instruction for ${stepLabel}:`, e);
        return '';
    }
}

interface GroupAssetGenOptions {
    groupId: string;
    groupName: string;
    groupType: 'exercise' | 'meal';
    forceRegen?: boolean;
    themeId?: string;
    targetStatus?: 'auto' | 'draft' | 'active';
    jobId?: string;
    onProgress?: (progress: { generated: number; errors: number; skipped: number; total: number }) => Promise<void>;
}

export class BatchAssetService {

    /**
     * Generates all missing assets for a specific group (Exercise or Meal)
     * Hardened Flow: Sequential to avoid rate limits, Dual Coach for exercises.
     */
    static async generateGroupAssets(options: GroupAssetGenOptions) {
        console.log(`[Batch] Starting Group Generation for ${options.groupName} (${options.groupId})`);
        const { groupName, groupType, forceRegen, targetStatus = 'auto' } = options;
        const movementId = AssetPromptService.normalizeToId(groupName);

        // 1. Instructions & Text (Atomic Meta)
        const mainKey = groupType === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;
        const metaKey = `${mainKey}_meta`;

        let mainInstructions = await this.getAssetValue(metaKey);
        if (!mainInstructions || forceRegen) {
            console.log(`[Batch] Generating Instructions for ${groupName}`);
            const instructions = await AssetPromptService.generateInstructions(groupName, groupType);
            if (instructions) {
                await this.cacheAsset(metaKey, JSON.stringify(instructions), 'json');
                mainInstructions = instructions;
            }
        }

        let steps = (mainInstructions as any)?.instructions || (mainInstructions as any)?.steps || [];
        const stepCount = steps.length > 0 ? steps.length : (groupType === 'exercise' ? 6 : 4);

        // 2. Collect Assets to Generate
        const assetsToGenerate: {
            key: string;
            subtype: 'main' | 'step';
            label?: string;
            context?: string;
            identity?: 'atlas' | 'nova' | 'mannequin'
        }[] = [];

        if (groupType === 'exercise') {
            // Atlas Hero & Steps
            assetsToGenerate.push({ key: `ex_${movementId}_atlas_main`, subtype: 'main', label: 'Atlas Hero', identity: 'atlas', context: (mainInstructions as any)?.description || `${groupName} by Coach Atlas.` });
            for (let i = 1; i <= stepCount; i++) {
                const instr = steps[i - 1];
                const contextText = instr ? (instr.detailed || instr.instruction || instr.description || "") : `Step ${i} of ${groupName}.`;
                assetsToGenerate.push({ key: `ex_${movementId}_atlas_step_${i}`, subtype: 'step', label: instr?.label || `Atlas Step ${i}`, identity: 'atlas', context: contextText });
            }

            // Nova Hero & Steps
            assetsToGenerate.push({ key: `ex_${movementId}_nova_main`, subtype: 'main', label: 'Nova Hero', identity: 'nova', context: (mainInstructions as any)?.description || `${groupName} by Coach Nova.` });
            for (let i = 1; i <= stepCount; i++) {
                const instr = steps[i - 1];
                const contextText = instr ? (instr.detailed || instr.instruction || instr.description || "") : `Step ${i} of ${groupName}.`;
                assetsToGenerate.push({ key: `ex_${movementId}_nova_step_${i}`, subtype: 'step', label: instr?.label || `Nova Step ${i}`, identity: 'nova', context: contextText });
            }
        } else {
            // Meal Hero & Steps
            assetsToGenerate.push({ key: `meal_${movementId}_main`, subtype: 'main', label: 'Hero Image', context: (mainInstructions as any)?.description || (mainInstructions as any)?.textContext || groupName });
            for (let i = 1; i <= stepCount; i++) {
                const instr = steps[i - 1];
                const contextText = instr ? (instr.detailed || instr.instruction || instr.description || "") : `Preparing ${groupName}, Step ${i}.`;
                assetsToGenerate.push({ key: `meal_${movementId}_step_${i}`, subtype: 'step', label: instr?.label || `Step ${i}`, context: contextText });
            }
        }

        // 3. Reset statuses for this group if forceRegen or starting fresh
        if (forceRegen) {
            console.log(`[Batch] Hard Resetting statuses for ${groupName}`);
            const keysToReset = assetsToGenerate.map(a => a.key);
            await pool.query(`DELETE FROM cached_assets WHERE key = ANY($1)`, [keysToReset]);
        }

        // 4. Concurrent Generation Loop (Limit 3)
        const total = assetsToGenerate.length;
        const results = { generated: 0, errors: 0, skipped: 0, total };

        // Instruction Cache for this group (de-duplication)
        const instructionCache: Record<string, { detailed: string, simple: string }> = {};

        // Shared Background Style (Visual Consistency)
        const backgroundStyle = groupType === 'exercise'
            ? "Cinematic high-end professional private gym, dark moody lighting, premium equipment background."
            : "Kitchen setting, shallow depth of field, high-end studio food photography lighting.";

        // Initial Progress Call
        if (options.onProgress) await options.onProgress(results);

        let atlasRef: string | null = null;
        let novaRef: string | null = null;
        if (groupType === 'exercise') {
            atlasRef = (await this.getAssetValue('system_coach_atlas_ref')) as string;
            novaRef = (await this.getAssetValue('system_coach_nova_ref')) as string;
        }

        // Split work into chunks of 3 for parallel processing
        const chunkSize = 3;
        for (let i = 0; i < assetsToGenerate.length; i += chunkSize) {
            const chunk = assetsToGenerate.slice(i, i + chunkSize);

            await Promise.all(chunk.map(async (asset) => {
                const exists = await this.checkAssetExists(asset.key);
                if (exists && !forceRegen) {
                    results.skipped++;
                    return;
                }

                // Mark as generating
                await this.cacheAsset(asset.key, '', 'image', 'generating');

                try {
                    const prompt = await AssetPromptService.constructPrompt({
                        key: asset.key,
                        groupName,
                        groupType,
                        subtype: asset.subtype,
                        label: asset.label,
                        type: 'image',
                        context: asset.context,
                        backgroundStyle
                    });

                    let refImage: string | undefined = undefined;
                    if (asset.identity === 'atlas') refImage = atlasRef || undefined;
                    if (asset.identity === 'nova') refImage = novaRef || undefined;

                    // De-duplicated Instruction Generation
                    const cacheKey = asset.label || asset.key;
                    if (!instructionCache[cacheKey]) {
                        console.log(`[Batch] Generating shared instructions for ${cacheKey}...`);
                        const detailedText = await generateInstructionText(groupName, cacheKey, groupType, 'detailed');
                        const simpleText = await generateInstructionText(groupName, cacheKey, groupType, 'simple');
                        instructionCache[cacheKey] = { detailed: detailedText, simple: simpleText };
                    }
                    const { detailed: detailedText, simple: simpleText } = instructionCache[cacheKey];

                    console.log(`[Batch] Generating image for ${asset.key} (Concurrent chunk)...`);
                    await generateAsset({
                        mode: 'image',
                        prompt,
                        key: asset.key,
                        status: targetStatus,
                        movementId,
                        imageInput: refImage,
                        model: 'models/gemini-3-pro-image-preview',
                        persona: asset.identity as any,
                        stepIndex: asset.subtype === 'step' ? parseInt(asset.key.split('_step_')[1]) : undefined,
                        textContext: detailedText || asset.context,
                        textContextSimple: simpleText,
                        originalName: groupName
                    });

                    results.generated++;
                    console.log(`[Batch] Success: ${asset.key}`);
                } catch (e: any) {
                    console.error(`[Batch] Failed to generate ${asset.key}:`, e.message);
                    results.errors++;
                    await this.cacheAsset(asset.key, '', 'image', 'failed');
                }
            }));

            // Progress Update after each chunk
            if (options.onProgress) {
                await options.onProgress(results);
            }

            // Small safety delay between chunks to avoid transient network issues
            if (i + chunkSize < assetsToGenerate.length) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        TranslationService.publishAndTranslate(options.groupId, groupName, groupType)
            .catch(err => console.error("[Batch] Translation trigger failed", err));

        console.log(`[Batch] Group ${groupName} complete. Gen: ${results.generated}, Err: ${results.errors}, Skip: ${results.skipped}`);
        return results;
    }

    static async runNightlyBatch() {
        console.log("Starting Nightly Batch Asset Generation...");
        const report = { generated: 0, errors: 0, skipped: 0 };

        const exerciseRows = await pool.query(
            `SELECT id, name FROM training_exercises WHERE name IS NOT NULL AND name != ''`
        );
        for (const row of exerciseRows.rows) {
            const normalizedId = AssetPromptService.normalizeToId(row.name);
            await this.syncExerciseVideos(row.id, row.name, normalizedId);
        }

        const mealRows = await pool.query(`SELECT id, name FROM meals`);
        for (const row of mealRows.rows) {
            await this.syncMealVideos(row.id, row.name, AssetPromptService.normalizeToId(row.name));
        }

        console.log("Nightly Batch Complete (Sync Only)", report);
        return report;
    }

    private static async syncExerciseVideos(dbId: string, name: string, normalizedId: string) {
        const atlasKey = `video_exercise_${normalizedId}_atlas`;
        const novaKey = `video_exercise_${normalizedId}_nova`;
        const [atlasUrl, novaUrl] = await Promise.all([
            this.getAssetValue(atlasKey),
            this.getAssetValue(novaKey)
        ]);

        if (atlasUrl || novaUrl) {
            await pool.query(
                `UPDATE training_exercises SET video_atlas = COALESCE($1, video_atlas), video_nova = COALESCE($2, video_nova) WHERE name = $3`,
                [atlasUrl, novaUrl, name]
            );
        }
    }

    private static async syncMealVideos(dbId: string, name: string, normalizedId: string) {
        const stepMap: Record<string, string> = {};
        for (let i = 1; i <= 10; i++) {
            const key = `meal_${normalizedId}_step${i}`;
            const val = await this.getAssetValue(key);
            if (val && typeof val === 'string') {
                stepMap[i.toString()] = val;
            }
        }
        if (Object.keys(stepMap).length > 0 && dbId) {
            await pool.query(`UPDATE meals SET step_videos = $1 WHERE id = $2`, [JSON.stringify(stepMap), dbId]);
        }
    }

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

    private static async checkAssetExists(key: string): Promise<boolean> {
        const res = await pool.query(`SELECT status, updated_at FROM cached_assets WHERE key=$1`, [key]);
        if (res.rowCount === 0) return false;
        const { status, updated_at } = res.rows[0];
        if (['active', 'auto'].includes(status)) return true;
        if (status === 'generating') {
            const isStale = new Date().getTime() - new Date(updated_at).getTime() > 30 * 60 * 1000; // 30 min
            return !isStale;
        }
        return false;
    }
}
