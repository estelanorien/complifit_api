import { pool } from '../../infra/db/pool.js';
import { AiService } from './aiService.js';

const aiService = new AiService();

// --- CONSTANTS (Mirrored from Frontend to ensure consistency) ---
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

type JobType = 'MEAL_PLAN' | 'IMAGE' | 'MEAL_DETAILS' | 'EXERCISE_GENERATION' | 'MEAL_GENERATION';

export class JobProcessor {
    private processing = false;
    private intervalId: NodeJS.Timeout | null = null;
    private POLLING_INTERVAL = 3000; // 3 seconds

    constructor() {
        console.log('[JobProcessor] Initialized');
    }

    start() {
        if (this.intervalId) return;
        console.log('[JobProcessor] Starting poller...');
        this.intervalId = setInterval(() => this.processNextJob(), this.POLLING_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    async submitJob(userId: string, type: JobType, payload: any): Promise<string> {
        const { rows } = await pool.query(
            `INSERT INTO generation_jobs(user_id, type, payload, status) 
       VALUES($1, $2, $3, 'PENDING') 
       RETURNING id`,
            [userId, type, payload]
        );
        // Trigger immediate check (optional optimization)
        // this.processNextJob(); 
        return rows[0].id;
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
                const { rows } = await client.query(`
          SELECT id, user_id, type, payload 
          FROM generation_jobs 
          WHERE status = 'PENDING' 
          ORDER BY created_at ASC 
          LIMIT 1 
          FOR UPDATE SKIP LOCKED
        `);

                if (rows.length === 0) {
                    await client.query('ROLLBACK');
                    return; // No jobs
                }

                const job = rows[0];
                console.log(`[JobProcessor] Picked up job ${job.id} (${job.type})`);

                // Mark as PROCESSING
                await client.query(
                    `UPDATE generation_jobs SET status = 'PROCESSING', updated_at = now() WHERE id = $1`,
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
                    console.log(`[JobProcessor] Job ${job.id} COMPLETED`);

                } catch (err: any) {
                    console.error(`[JobProcessor] Job ${job.id} FAILED:`, err);
                    await pool.query(
                        `UPDATE generation_jobs SET status = 'FAILED', error = $1, updated_at = now() WHERE id = $2`,
                        [err.message || String(err), job.id]
                    );
                }

            } catch (err) {
                await client.query('ROLLBACK');
                console.error('[JobProcessor] Error in transaction:', err);
            } finally {
                client.release();
            }

        } catch (e) {
            console.error('[JobProcessor] Polling error:', e);
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
            // case 'MEAL_PLAN': return this.handleMealPlanJob(payload);
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
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        const words = clean.split(' ').filter(w => w.length > 0).sort();
        return `${prefix}_${words.join('_')}`;
    }

    private async handleExerciseGeneration(payload: any): Promise<any> {
        const { name, instructions, userProfile } = payload;
        if (!name) throw new Error('Exercise name required');

        const sex = userProfile?.biologicalSex || userProfile?.gender || 'male';
        const primaryId = userProfile?.coachPreference || (sex === 'female' ? 'nova' : 'atlas');

        const primaryCoach = COACH_PROFILES[primaryId as keyof typeof COACH_PROFILES] || COACH_PROFILES.atlas;
        const secondaryId = primaryId === 'atlas' ? 'nova' : 'atlas';
        const secondaryCoach = COACH_PROFILES[secondaryId as keyof typeof COACH_PROFILES];

        const baseKey = this.normalizeKey(name, 'movement');

        // --- 1. GENERATE PRIMARY MAIN ---
        console.log(`[JobProcessor] Generating PRIMARY MAIN (${primaryId}) for ${name}`);
        const primaryPrompt = `Fitness photography of ${name} exercise. Proper form, athletic model (${primaryCoach.description}), gym setting. ${VITALITY_IMAGE_STYLE}. Action shot, dynamic angle. STRICTLY NO TEXT OR LABELS.`;

        try {
            const { base64: primaryImage } = await aiService.generateImage({ prompt: primaryPrompt });
            if (!primaryImage) throw new Error('Failed to generate primary main image');

            await this.saveAsset(`${baseKey}_main`, primaryImage, { prompt: primaryPrompt, source: 'exercise-job-primary', persona: primaryId, movementId: baseKey });
            await this.saveAsset(`${baseKey}_${primaryId}`, primaryImage, { prompt: primaryPrompt, source: 'exercise-job-primary', persona: primaryId, movementId: baseKey });

            // --- 2. GENERATE SECONDARY MAIN ---
            console.log(`[JobProcessor] Generating SECONDARY MAIN (${secondaryId}) for ${name}`);
            const secondaryPrompt = `Fitness photography of ${name} exercise. Proper form, athletic model (${secondaryCoach.description}), gym setting. ${VITALITY_IMAGE_STYLE}. Action shot, dynamic angle. STRICTLY NO TEXT OR LABELS.`;

            let secondaryMainImage: string | undefined;
            try {
                const { base64: sImg } = await aiService.generateImage({ prompt: secondaryPrompt });
                secondaryMainImage = sImg;
                if (secondaryMainImage) {
                    await this.saveAsset(`${baseKey}_${secondaryId}`, secondaryMainImage, { prompt: secondaryPrompt, source: 'exercise-job-secondary', persona: secondaryId, movementId: baseKey });
                }
            } catch (e) {
                console.error(`[JobProcessor] SECONDARY MAIN generation failed for ${name}`, e);
            }

            // --- 3. GENERATE STEP IMAGES (Both Personas) ---
            if (Array.isArray(instructions) && instructions.length > 0) {
                console.log(`[JobProcessor] Generating ${instructions.length} STEPS for ${name} (Both personas)`);

                for (let i = 0; i < instructions.length; i++) {
                    const step = instructions[i];
                    const stepIndex = i + 1;
                    const instructionText = step.detailed || step.simple;

                    // A. Primary Step
                    const pStepKey = `${baseKey}_${primaryId}_step_${stepIndex}`;
                    const pStepPrompt = `IMPORTANT: Match person (${primaryCoach.description}). Action: ${instructionText}. Fitness photo of ${name} step ${stepIndex}. ${VITALITY_IMAGE_STYLE}. No text.`;

                    try {
                        const { base64: pStepImg } = await aiService.generateImage({
                            prompt: pStepPrompt,
                            referenceImage: primaryImage // Use main image as reference for consistency
                        });
                        if (pStepImg) {
                            await this.saveAsset(pStepKey, pStepImg, { prompt: pStepPrompt, source: 'exercise-job-step', persona: primaryId, step: stepIndex, movementId: baseKey });
                            // Also save as generic step if it's the primary persona
                            await this.saveAsset(`${baseKey}_step_${stepIndex}`, pStepImg, { prompt: pStepPrompt, source: 'exercise-job-step', persona: primaryId, step: stepIndex, movementId: baseKey });
                        }
                    } catch (e) {
                        console.error(`[JobProcessor] Primary step ${stepIndex} failed for ${name}`, e);
                    }

                    // B. Secondary Step
                    if (secondaryMainImage) {
                        const sStepKey = `${baseKey}_${secondaryId}_step_${stepIndex}`;
                        const sStepPrompt = `IMPORTANT: Match person (${secondaryCoach.description}). Action: ${instructionText}. Fitness photo of ${name} step ${stepIndex}. ${VITALITY_IMAGE_STYLE}. No text.`;

                        try {
                            const { base64: sStepImg } = await aiService.generateImage({
                                prompt: sStepPrompt,
                                referenceImage: secondaryMainImage
                            });
                            if (sStepImg) {
                                await this.saveAsset(sStepKey, sStepImg, { prompt: sStepPrompt, source: 'exercise-job-step', persona: secondaryId, step: stepIndex, movementId: baseKey });
                            }
                        } catch (e) {
                            console.error(`[JobProcessor] Secondary step ${stepIndex} failed for ${name}`, e);
                        }
                    }
                }
            }

            return { assetUrl: primaryImage };

        } catch (e: any) {
            console.error(`[JobProcessor] handleExerciseGeneration failed:`, e);
            throw e;
        }
    }

    private async handleMealGeneration(payload: any): Promise<any> {
        const { name, instructions, ingredients } = payload;
        if (!name) throw new Error('Meal name required');

        const baseKey = this.normalizeKey(name, 'meal');
        const ingredientText = Array.isArray(ingredients) ? ingredients.join(', ') : '';

        // --- 1. GENERATE MAIN ---
        console.log(`[JobProcessor] Generating MAIN image for meal: ${name}`);
        const mainPrompt = `Gourmet food photography of ${name}. Ingredients: ${ingredientText}. Plated beautifully, professional lighting. ${VITALITY_IMAGE_STYLE}. STRICTLY NO TEXT OR LABELS.`;

        try {
            const { base64: mainImage } = await aiService.generateImage({ prompt: mainPrompt });
            if (!mainImage) throw new Error('Failed to generate main meal image');

            await this.saveAsset(`${baseKey}_main`, mainImage, { prompt: mainPrompt, source: 'meal-job-main', movementId: baseKey });
            // Legacy/Generic key support
            await this.saveAsset(baseKey, mainImage, { prompt: mainPrompt, source: 'meal-job-main', movementId: baseKey });

            // --- 2. GENERATE STEPS ---
            if (Array.isArray(instructions) && instructions.length > 0) {
                console.log(`[JobProcessor] Generating ${instructions.length} steps for meal: ${name}`);
                for (let i = 0; i < instructions.length; i++) {
                    const step = instructions[i];
                    const stepIndex = i; // MealItem uses 0-indexed for recipes
                    const stepText = step.detailed || step.simple;

                    const stepKey = `${baseKey}_step_${stepIndex}`;
                    const stepPrompt = `Food preparation step: ${stepText}. Close-up, professional food photography style. ${VITALITY_IMAGE_STYLE}. No text.`;

                    try {
                        const { base64: stepImg } = await aiService.generateImage({
                            prompt: stepPrompt,
                            referenceImage: mainImage // Use main meal as reference
                        });
                        if (stepImg) {
                            await this.saveAsset(stepKey, stepImg, { prompt: stepPrompt, source: 'meal-job-step', step: stepIndex, movementId: baseKey });
                        }
                    } catch (e) {
                        console.error(`[JobProcessor] Meal step ${stepIndex} failed for ${name}`, e);
                    }
                }
            }

            return { assetUrl: mainImage };

        } catch (e: any) {
            console.error(`[JobProcessor] handleMealGeneration failed:`, e);
            throw e;
        }
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
                `INSERT INTO cached_asset_meta(key, prompt, source, mode, movement_id, persona, step_index)
                 VALUES($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (key) DO UPDATE SET 
                    prompt = EXCLUDED.prompt, 
                    source = EXCLUDED.source, 
                    mode = EXCLUDED.mode, 
                    movement_id = EXCLUDED.movement_id,
                    persona = EXCLUDED.persona,
                    step_index = EXCLUDED.step_index`,
                [
                    key,
                    meta.prompt || null,
                    meta.source || 'auto-gen',
                    meta.persona || meta.mode || null,
                    meta.movementId || (key.startsWith('movement_') ? key.split('_').slice(0, 2).join('_') : null), // Best effort movement_id: movement_name
                    meta.persona || null,
                    meta.step !== undefined ? meta.step : null
                ]
            );
        } catch (e) {
            console.error(`[JobProcessor] Failed to save asset ${key}:`, e);
        }
    }
}

export const jobProcessor = new JobProcessor();
