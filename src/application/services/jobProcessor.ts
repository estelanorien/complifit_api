import { pool } from '../../infra/db/pool.js';
import { AiService } from './aiService.js';
import { translationService } from './translationService.js';
import { logger } from '../../infra/logger.js';

const aiService = new AiService();

const VITALITY_IMAGE_STYLE = "photorealistic, 8k resolution, cinematic lighting, professional photography, soft focus background, high detail, masterpiece, no text, no watermark, no labels, no characters, no letters, no words, no UI, no buttons, no captions, clean image";

const COACH_PROFILES = {
    atlas: {
        description: "Caucasian male, 28 years old, short faded dark-blonde hair, clean shaven. Wearing a simple grey athletic t-shirt. Friendly but professional, trustworthy.",
        refKey: "system_coach_atlas_ref"
    },
    nova: {
        description: "Caucasian female, 28 years old, long blonde hair in a high ponytail. Wearing a simple black athletic tank top. Friendly, confident smile, approachable.",
        refKey: "system_coach_nova_ref"
    }
};

type JobType = 'MEAL_PLAN' | 'IMAGE' | 'MEAL_DETAILS' | 'EXERCISE_GENERATION' | 'MEAL_GENERATION' | 'CONTENT_UPGRADE' | 'BATCH_ASSET_GENERATION';

export class JobProcessor {
    private processing = false;
    private intervalId: NodeJS.Timeout | null = null;
    private POLLING_INTERVAL = 3000; // 3 seconds

    constructor() {
        logger.info('[JobProcessor] Initialized');
    }

    start() {
        if (this.intervalId) return;
        logger.info('[JobProcessor] Starting poller...');
        this.intervalId = setInterval(() => this.processNextJob(), this.POLLING_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Submit a job with deduplication and priority support.
     * @param userId - The user requesting the job
     * @param type - Job type (IMAGE, EXERCISE_GENERATION, etc.)
     * @param payload - Job payload
     * @param priority - 3=HIGH, 2=MEDIUM, 1=LOW (default)
     * @param jobKey - Optional canonical key for deduplication (e.g., 'MAIN_IMAGE_movement_bench_press_atlas')
     */
    async submitJob(userId: string, type: JobType, payload: any, priority: number = 1, jobKey?: string): Promise<{ jobId: string, isNew: boolean }> {
        // 1. Check for existing job with same key (deduplication)
        if (jobKey) {
            const { rows: existing } = await pool.query(
                `SELECT id FROM generation_jobs 
                 WHERE job_key = $1 AND status IN ('PENDING', 'PROCESSING')
                 LIMIT 1`,
                [jobKey]
            );
            if (existing.length > 0) {
                logger.info(`[JobProcessor] Dedup: Found existing job ${existing[0].id} for key ${jobKey}`);
                return { jobId: existing[0].id, isNew: false };
            }
        }

        // 2. Insert new job with priority and expires_at
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour TTL
        const { rows } = await pool.query(
            `INSERT INTO generation_jobs(user_id, type, payload, status, priority, job_key, expires_at) 
             VALUES($1, $2, $3, 'PENDING', $4, $5, $6) 
             RETURNING id`,
            [userId, type, payload, priority, jobKey || null, expiresAt]
        );

        logger.info(`[JobProcessor] Created job ${rows[0].id}`, { type, priority, key: jobKey || 'none' });

        // Trigger immediate processing
        setImmediate(() => this.processNextJob());

        return { jobId: rows[0].id, isNew: true };
    }

    async getJobStatus(jobId: string, userId: string): Promise<any> {
        const { rows } = await pool.query(
            `SELECT id, status, result, error 
       FROM generation_jobs 
       WHERE id = $1 AND user_id = $2`,
            [jobId, userId]
        );
        return rows[0] || null;
    }

    private async processNextJob() {
        if (this.processing) return;

        try {
            this.processing = true;
            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // 1. Claim a job with SKIP LOCKED to prevent race conditions
                // Priority ordering: HIGH (3) > MEDIUM (2) > LOW (1)
                // Also reclaim jobs stuck in PROCESSING for > 5 minutes (heartbeat timeout)
                // Skip expired jobs
                const { rows } = await client.query(`
                    SELECT id, user_id, type, payload 
                    FROM generation_jobs 
                    WHERE (
                        status = 'PENDING' 
                        OR (status = 'PROCESSING' AND started_at < NOW() - INTERVAL '5 minutes')
                    )
                    AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY priority DESC, created_at ASC 
                    LIMIT 1 
                    FOR UPDATE SKIP LOCKED
                `);

                if (rows.length === 0) {
                    await client.query('ROLLBACK');
                    return; // No jobs
                }

                const job = rows[0];
                logger.info(`[JobProcessor] Picked up job ${job.id}`, { jobType: job.type });

                // Mark as PROCESSING with started_at for heartbeat timeout
                await client.query(
                    `UPDATE generation_jobs SET status = 'PROCESSING', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
                    [job.id]
                );

                await client.query('COMMIT');
                // Release lock on this row by committing, but we still "own" the work because status is PROCESSING.
                // For simple locking, this is fine. If worker crashes, job stays PROCESSING. 
                // A refined version would use a "claimed_at" and timeout. For now simple.

                // 2. Execute Work
                try {
                    const result = await this.executeJob(job.type, job.payload);

                    await pool.query(
                        `UPDATE generation_jobs SET status = 'COMPLETED', result = $1, updated_at = now() WHERE id = $2`,
                        [JSON.stringify(result), job.id]
                    );
                    logger.info(`[JobProcessor] Job ${job.id} COMPLETED`);

                } catch (err: any) {
                    logger.error(`[JobProcessor] Job ${job.id} FAILED`, err, { jobId: job.id, jobType: job.type });
                    await pool.query(
                        `UPDATE generation_jobs SET status = 'FAILED', error = $1, updated_at = now() WHERE id = $2`,
                        [err.message || String(err), job.id]
                    );
                }

            } catch (err) {
                await client.query('ROLLBACK');
                logger.error('[JobProcessor] Error in transaction', err as Error);
            } finally {
                client.release();
            }

        } catch (e) {
            logger.error('[JobProcessor] Polling error', e as Error);
        } finally {
            this.processing = false;
        }
    }

    private async executeJob(type: JobType, payload: any): Promise<any> {
        switch (type) {
            case 'IMAGE':
                return this.handleImageJob(payload);
            case 'EXERCISE_GENERATION':
                return this.handleExerciseGeneration(payload);
            case 'MEAL_GENERATION':
                return this.handleMealGeneration(payload);
            case 'CONTENT_UPGRADE':
                return this.handleContentUpgrade(payload);
            case 'BATCH_ASSET_GENERATION':
                return this.handleBatchAssetGeneration(payload);
            default:
                throw new Error(`Unknown job type: ${type}`);
        }
    }

    private async handleImageJob(payload: any): Promise<any> {
        const { prompt, cacheKey, meta } = payload;

        // Call existing AI service
        const { base64: image } = await aiService.generateImage({ prompt }); // Assuming base64 response

        if (!image) throw new Error('AI generation returned no image');

        // PERSISTENCE: Save to assets table immediately
        if (cacheKey) {
            await this.saveAsset(cacheKey, image, meta);
        }

        return { assetUrl: image }; // Return same base64 for immediate UI use if needed
    }

    private normalizeKey(str: string, prefix: string): string {
        if (!str) return `${prefix}_unknown`;
        let clean = str.toLowerCase().trim();
        // Frontend-compatible normalization: No sorting, preserve order, use underscores
        clean = clean.replace(/[^a-z0-9]+/g, '_');
        clean = clean.replace(/^_+|_+$/g, '');
        return prefix ? `${prefix}_${clean}` : clean;
    }

    private getContentHash(text: string): string {
        if (!text) return '0';
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = (hash * 33) ^ text.charCodeAt(i);
        }
        return (hash >>> 0).toString(36);
    }

    // ... (keep intervening methods if any, but getContentHash is next in file) ...

    // ... inside saveAsset or just apply logic to saveAsset call sites?
    // Waiting, saveAsset is far below. I should probably do 2 separate chunks or one big one if close.
    // normalizeKey is at 206. saveAsset is at 475. separate chunks.

    // Let's just do normalizeKey first.
    // actually, I can do checking movementId in saveAsset in a separate block.
    // wait, saveAsset extraction logic:
    // meta.movementId || (key.startsWith('movement_') ? ... : null)
    // I will change this to:
    // meta.movementId || (key.match(/^(movement_|meal_)/) ? key.split('_').slice(0, 2).join('_') : null)
    // But actually, if key is meal_foo_bar, slice(0,2) -> meal_foo.
    // Normalized key: meal_nohutlu_bulgur...
    // slice(0,2) -> meal_nohutlu.
    // Is movement_id supposed to be the FULL key or just the prefix+firstword?
    // In admin.ts: `normalizeToMovementId` uses `normalizeKey`.
    // So movement_id IS the full key usually.
    // So `key` IS the `movement_id` if it's the main asset.
    // For `meal_nohutlu_bulgur_pilavi_main` -> `movement_id` should be `meal_nohutlu_bulgur_pilavi`.
    // My previous logic was flawed regardless.
    // `meta.movementId` passed from `handleMealGeneration` IS `baseKey` which IS the correct ID.
    // So I don't strictly need to change the fallback if the caller passes it correctly.
    // `handleMealGeneration` passes it.
    // So only `normalizeKey` is the critical fix.

    private async handleExerciseGeneration(payload: any): Promise<any> {
        const { name, instructions, userProfile } = payload;
        if (!name) throw new Error('Exercise name required');

        const sex = userProfile?.biologicalSex || userProfile?.gender || 'male';
        const primaryId = userProfile?.coachPreference || (sex === 'female' ? 'nova' : 'atlas');

        const primaryCoach = COACH_PROFILES[primaryId as keyof typeof COACH_PROFILES] || COACH_PROFILES.atlas;
        const secondaryId = primaryId === 'atlas' ? 'nova' : 'atlas';
        const secondaryCoach = COACH_PROFILES[secondaryId as keyof typeof COACH_PROFILES];

        const baseKey = this.normalizeKey(name, 'movement');

        // PRE-FETCH COACH REFERENCES
        const primaryRef = await this.getAsset(primaryCoach.refKey);
        const secondaryRef = await this.getAsset(secondaryCoach.refKey);

        if (primaryRef) logger.debug(`[JobProcessor] Using reference image for ${primaryId}`);
        if (secondaryRef) logger.debug(`[JobProcessor] Using reference image for ${secondaryId}`);

        // --- 1. GENERATE PRIMARY MAIN ---
        logger.info(`[JobProcessor] Generating PRIMARY MAIN (${primaryId}) for ${name}`);
        const primaryPrompt = `Portrait of ${primaryCoach.description} performing ${name} exercise. Proper form, gym setting. ${VITALITY_IMAGE_STYLE}. Action shot, dynamic angle. STRICTLY NO TEXT OR LABELS.`;

        try {
            const { base64: primaryImage } = await aiService.generateImage({
                prompt: primaryPrompt,
                referenceImage: primaryRef || undefined // Use coach reference if available
            });
            if (!primaryImage) throw new Error('Failed to generate primary main image');

            await this.saveAsset(`${baseKey}_main`, primaryImage, { prompt: primaryPrompt, source: 'exercise-job-primary', persona: primaryId, movementId: baseKey });
            await this.saveAsset(`${baseKey}_${primaryId}`, primaryImage, { prompt: primaryPrompt, source: 'exercise-job-primary', persona: primaryId, movementId: baseKey });

            // --- PROACTIVE LOCKING: Translation ---
            translationService.preTranslate([name, ...(instructions || [])], 'exercise');

            // --- 2. GENERATE SECONDARY MAIN ---
            logger.info(`[JobProcessor] Generating SECONDARY MAIN (${secondaryId}) for ${name}`);
            const secondaryPrompt = `Portrait of ${secondaryCoach.description} performing ${name} exercise. Proper form, gym setting. ${VITALITY_IMAGE_STYLE}. Action shot, dynamic angle. STRICTLY NO TEXT OR LABELS.`;

            let secondaryMainImage: string | undefined;
            try {
                const { base64: sImg } = await aiService.generateImage({
                    prompt: secondaryPrompt,
                    referenceImage: secondaryRef || undefined // Use coach reference if available
                });
                secondaryMainImage = sImg;
                if (secondaryMainImage) {
                    await this.saveAsset(`${baseKey}_${secondaryId}`, secondaryMainImage, { prompt: secondaryPrompt, source: 'exercise-job-secondary', persona: secondaryId, movementId: baseKey });
                }
            } catch (e) {
                logger.error(`[JobProcessor] SECONDARY MAIN generation failed for ${name}`, e as Error);
            }

            // --- 3. GENERATE STEP IMAGES (Both Personas) ---
            if (Array.isArray(instructions) && instructions.length > 0) {
                logger.info(`[JobProcessor] Generating ${instructions.length} STEPS for ${name} (Both personas)`);

                for (let i = 0; i < instructions.length; i++) {
                    const step = instructions[i];
                    const stepIndex = i + 1;
                    const instructionText = step.detailed || step.simple;

                    // A. Primary Step
                    const contentHash = this.getContentHash(instructionText);
                    const pStepKey = `${baseKey}_${primaryId}_step_${stepIndex}_${contentHash}`;
                    const pStepPrompt = `IMPORTANT: Show ${primaryCoach.description}. Action: ${instructionText}. Fitness photo of ${name} step ${stepIndex}. ${VITALITY_IMAGE_STYLE}. No text.`;

                    try {
                        const { base64: pStepImg } = await aiService.generateImage({
                            prompt: pStepPrompt,
                            referenceImage: primaryImage // Use generated main image to keep outfit consistency for steps
                        });
                        if (pStepImg) {
                            await this.saveAsset(pStepKey, pStepImg, { prompt: pStepPrompt, source: 'exercise-job-step', persona: primaryId, step: stepIndex, movementId: baseKey });
                            // Also save as generic step if it's the primary persona
                            await this.saveAsset(`${baseKey}_step_${stepIndex}_${contentHash}`, pStepImg, { prompt: pStepPrompt, source: 'exercise-job-step', persona: primaryId, step: stepIndex, movementId: baseKey });
                        }
                    } catch (e) {
                        logger.error(`[JobProcessor] Primary step ${stepIndex} failed for ${name}`, e as Error);
                    }

                    // B. Secondary Step
                    if (secondaryMainImage) {
                        const sStepKey = `${baseKey}_${secondaryId}_step_${stepIndex}_${contentHash}`;
                        const sStepPrompt = `IMPORTANT: Show ${secondaryCoach.description}. Action: ${instructionText}. Fitness photo of ${name} step ${stepIndex}. ${VITALITY_IMAGE_STYLE}. No text.`;

                        try {
                            const { base64: sStepImg } = await aiService.generateImage({
                                prompt: sStepPrompt,
                                referenceImage: secondaryMainImage // Use generated main image for steps
                            });
                            if (sStepImg) {
                                await this.saveAsset(sStepKey, sStepImg, { prompt: sStepPrompt, source: 'exercise-job-step', persona: secondaryId, step: stepIndex, movementId: baseKey });
                            }
                        } catch (e) {
                            logger.error(`[JobProcessor] Secondary step ${stepIndex} failed for ${name}`, e as Error);
                        }
                    }
                }
            }

            return { assetUrl: primaryImage };

        } catch (e: any) {
            logger.error(`[JobProcessor] handleExerciseGeneration failed`, e);
            throw e;
        }
    }

    private async getAsset(key: string): Promise<string | null> {
        try {
            const { rows } = await pool.query(
                `SELECT value FROM cached_assets WHERE key = $1 LIMIT 1`,
                [key]
            );
            if (rows.length > 0) {
                return rows[0].value;
            }
            return null;
        } catch (e) {
            logger.error(`[JobProcessor] Failed to fetch asset ${key}`, e as Error);
            return null;
        }
    }

    private async handleMealGeneration(payload: any): Promise<any> {
        const { name, instructions, ingredients } = payload;
        if (!name) throw new Error('Meal name required');

        // 1. Canonicalization (Language Agnostic Matching)
        // Translate name to English to use as the unique ID for this meal concepts
        const canonicalName = await translationService.translateText(name, 'en', 'meal_name');
        const baseKey = this.normalizeKey(canonicalName, 'meal');
        const originalKey = this.normalizeKey(name, 'meal');

        // Translate ingredients for better image generation
        const ingredientText = Array.isArray(ingredients) ? ingredients.join(', ') : '';
        const engIngredients = await translationService.translateText(ingredientText, 'en', 'ingredients');

        // --- 1. GENERATE MAIN ---
        logger.info(`[JobProcessor] Generating MAIN image for meal: ${name} (Canonical: ${canonicalName})`);
        const mainPrompt = `Professional food photography of ${canonicalName}. Ingredients visible: ${engIngredients}. centered composition, steam rising, delicious texture, gourmet plating, dramatic side lighting, 8k resolution. STRICTLY NO TEXT, NO LABELS, NO RECIPES WRITTEN.`;

        try {
            const { base64: mainImage } = await aiService.generateImage({ prompt: mainPrompt });
            if (!mainImage) throw new Error('Failed to generate main meal image');

            // Save under Canonical Key (The "Real" Asset)
            await this.saveAsset(`${baseKey}_main`, mainImage, { prompt: mainPrompt, source: 'meal-job-main', movementId: baseKey });

            // Save under Original Key (Alias for Frontend Discovery)
            // Link it to the Canonical movementId so Admin sees them as one group
            if (baseKey !== originalKey) {
                await this.saveAsset(`${originalKey}_main`, mainImage, { prompt: mainPrompt, source: 'meal-job-main-alias', movementId: baseKey });
            }
            // Legacy/Generic key support
            await this.saveAsset(baseKey, mainImage, { prompt: mainPrompt, source: 'meal-job-main', movementId: baseKey });


            // --- PROACTIVE LOCKING: Translation ---
            const ingredientsText = Array.isArray(payload.ingredients) ? payload.ingredients.join(', ') : (payload.ingredients || '');
            translationService.preTranslate([name, ingredientsText], 'meal');
            if (Array.isArray(instructions)) {
                const stepTexts = instructions.map((s: any) => s.detailed || s.simple || s);
                translationService.preTranslate(stepTexts, 'meal_step');
            }

            // --- 2. GENERATE STEPS ---
            if (Array.isArray(instructions) && instructions.length > 0) {
                logger.info(`[JobProcessor] Generating ${instructions.length} steps for meal: ${name}`);

                // Translate instructions to English for prompts
                const stepTexts = instructions.map((s: any) => s.detailed || s.simple || s);
                const engSteps = await translationService.translateList(stepTexts, 'en', 'meal_step');

                for (let i = 0; i < instructions.length; i++) {
                    const stepIndex = i; // MealItem uses 0-indexed for recipes
                    const stepText = engSteps[i] || stepTexts[i]; // Use English if available

                    // Use ContentHash of the ORIGINAL text for key stability on this machine
                    // But for canonical matching, we might want hash of English text? 
                    // Frontend uses original text. So stick to Original Text Hash for the Original Key.
                    // For Canonical Key, use English Hash? 
                    // Let's keep it simple: Save Canonical Image using a deterministic suffix if possible, 
                    // but steps are content-addressable.
                    // If we want "Step 1 of Chicken Rice" to match "Step 1 of Tavuk Pilav", 
                    // we need to know they are effectively the same step.
                    // For now, simpler: Just ensure the current user gets their images.
                    // Cross-language step matching is hard without semantic hash.
                    // We will save using the Original Key logic so Frontend finds it.

                    const originalHash = this.getContentHash(stepTexts[i]);
                    const originalStepKey = `${originalKey}_step_${stepIndex}_${originalHash}`;

                    // Also try to save a Canonical Step key?
                    const canonicalHash = this.getContentHash(stepText);
                    const canonicalStepKey = `${baseKey}_step_${stepIndex}_${canonicalHash}`;

                    const stepPrompt = `Food preparation step for ${canonicalName}: ${stepText}. Close-up, professional food photography style. ${VITALITY_IMAGE_STYLE}. No text.`;

                    try {
                        const { base64: stepImg } = await aiService.generateImage({
                            prompt: stepPrompt,
                            referenceImage: mainImage // Use main meal as reference
                        });
                        if (stepImg) {
                            // Save Canonical
                            await this.saveAsset(canonicalStepKey, stepImg, { prompt: stepPrompt, source: 'meal-job-step', step: stepIndex, movementId: baseKey });

                            // Save Original Alias
                            if (originalStepKey !== canonicalStepKey) {
                                await this.saveAsset(originalStepKey, stepImg, { prompt: stepPrompt, source: 'meal-job-step-alias', step: stepIndex, movementId: baseKey });
                            }
                        }
                    } catch (e) {
                        logger.error(`[JobProcessor] Meal step ${stepIndex} failed for ${name}`, e as Error);
                    }
                }
            }

            return { assetUrl: mainImage };

        } catch (e: any) {
            logger.error(`[JobProcessor] handleMealGeneration failed`, e);
            throw e;
        }
    }

    private async handleContentUpgrade(payload: any): Promise<any> {
        const { type, name, currentSteps = 0 } = payload;
        logger.info(`[JobProcessor] PROACTIVE UPGRADE: Upgrading ${type} "${name}"`, { currentSteps });

        const prompt = type === 'MEAL'
            ? `Upgrade this recipe into a "Golden Standard" recipe. Provide 8-10 high-quality, detailed instruction steps. Recipe: "${name}". Return JSON with "instructions" array (objects with "simple" and "detailed" strings) and "nutritionTips" array (3 items). Detailed steps must be 2-3 sentences.`
            : `Upgrade this exercise into a "Golden Standard" movement. Provide 8-10 high-quality, detailed instruction steps. Exercise: "${name}". Return JSON with "instructions" array (objects with "simple" and "detailed" strings). Detailed steps must be 2-3 sentences.`;

        try {
            const response: any = await aiService.generateText({ prompt });
            const data = typeof response === 'string' ? JSON.parse(response.replace(/```json|```/g, '')) : response;

            if (data && data.instructions && data.instructions.length >= 7) {
                logger.info(`[JobProcessor] UPGRADE SUCCESS: ${name} now has ${data.instructions.length} steps.`);

                if (type === 'MEAL') {
                    await pool.query(
                        `UPDATE meals SET recipe = recipe || $1 WHERE name = $2`,
                        [JSON.stringify({ instructions: data.instructions }), name]
                    );
                } else {
                    await pool.query(
                        `UPDATE exercises SET instructions = $1 WHERE name = $2`,
                        [JSON.stringify(data.instructions), name]
                    );
                }

                // OPTIONAL: Trigger image generation for the new steps
                // We could submit new IMAGE jobs here, but the frontend will do it lazily
                // or the next time it's viewed. Proactive is better though.
                if (type === 'MEAL') {
                    await this.handleMealGeneration({ name, instructions: data.instructions });
                } else {
                    await this.handleExerciseGeneration({ name, instructions: data.instructions });
                }

                // Trigger translations for upgraded text
                const textToTranslate = data.instructions.map((s: any) => s.detailed || s.simple || s);
                translationService.preTranslate([name, ...textToTranslate], type === 'MEAL' ? 'meal' : 'exercise');
            }
            return { success: true };
        } catch (e) {
            logger.error(`[JobProcessor] Content Upgrade failed for ${name}`, e as Error);
            throw e;
        }
    }

    private async handleBatchAssetGeneration(payload: any): Promise<any> {
        // This is a wrapper around BatchAssetService logic
        // We import it dynamically to avoid circular dependency issues if any
        const { BatchAssetService } = await import('../../services/BatchAssetService.js');

        // Pass the payload directly to the service
        // The service will now perform the one-by-one generation
        // IMPORTANT: We need to update the service to be "job-aware" if we want granular progress updates here
        // For now, let's let it run and return the final report.

        // TODO: Refactor BatchAssetService to take a "progressCallback" if possible, 
        // OR rely on the fact that it updates the DB row-by-row, so the frontend can polling 
        // the "assets" table independently if it wants deep granular verification.

        return await BatchAssetService.generateGroupAssets(payload);
    }

    private async saveAsset(key: string, value: string, meta: any) {
        try {
            // Ensure value has proper format for storage if it's a raw base64
            let processedValue = value;
            if (processedValue && !processedValue.startsWith('data:image')) {
                processedValue = `data:image/png;base64,${processedValue}`;
            }

            // 1. Save to cached_assets
            await pool.query(
                `INSERT INTO cached_assets(key, value, asset_type, status)
                 VALUES($1, $2, 'image', 'active')
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, status = 'active'`,
                [key, processedValue]
            );

            // 2. Save to cached_asset_meta
            await pool.query(
                `INSERT INTO cached_asset_meta(key, prompt, source, mode, movement_id, persona, step_index, created_by)
                 VALUES($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (key) DO UPDATE SET 
                    prompt = EXCLUDED.prompt, 
                    source = EXCLUDED.source, 
                    mode = EXCLUDED.mode, 
                    movement_id = EXCLUDED.movement_id,
                    persona = EXCLUDED.persona,
                    step_index = EXCLUDED.step_index,
                    created_by = EXCLUDED.created_by`,
                [
                    key,
                    meta.prompt || null,
                    meta.source || 'auto-gen',
                    meta.persona || meta.mode || null,
                    // Infer movement_id from key if not provided (now handles meals)
                    meta.movementId || (key.match(/^(movement_|meal_)/) ? key.split('_').slice(0, 2).join('_') : null),
                    meta.persona || null,
                    meta.step !== undefined ? meta.step : null,
                    'system'
                ]
            );
        } catch (e) {
            logger.error(`[JobProcessor] Failed to save asset ${key}`, e as Error);
        }
    }
}

export const jobProcessor = new JobProcessor();
