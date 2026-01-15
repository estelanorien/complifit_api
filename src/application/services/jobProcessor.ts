import { pool } from '../../infra/db/pool.js';
import { AiService } from './aiService.js';
import { cacheAsset } from './assetService.js'; // Assuming you have an assetService, if not we will query DB directly

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

type JobType = 'MEAL_PLAN' | 'IMAGE' | 'MEAL_DETAILS' | 'EXERCISE_GENERATION';

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

    private async handleExerciseGeneration(payload: any): Promise<any> {
        const { name, userProfile } = payload;
        if (!name) throw new Error('Exercise name required');

        // Logic:
        // 1. Determine Primary Persona (based on user)
        // 2. Generate Primary Image -> Save to `main` AND specific key
        // 3. Generate Secondary Image -> Save to specific key only

        const sex = userProfile?.biologicalSex || userProfile?.gender || 'male';
        const primaryId = userProfile?.coachPreference || (sex === 'female' ? 'nova' : 'atlas');

        const primaryCoach = COACH_PROFILES[primaryId as keyof typeof COACH_PROFILES] || COACH_PROFILES.atlas;
        const secondaryId = primaryId === 'atlas' ? 'nova' : 'atlas';
        const secondaryCoach = COACH_PROFILES[secondaryId as keyof typeof COACH_PROFILES];

        const baseKey = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_'); // Simple normalization

        // --- 1. GENERATE PRIMARY ---
        console.log(`[JobProcessor] Generating PRIMARY (${primaryId}) for ${name}`);
        const primaryPrompt = `Fitness photography of ${name} exercise. Proper form, athletic model (${primaryCoach.description}), gym setting. ${VITALITY_IMAGE_STYLE}. Action shot, dynamic angle. STRICTLY NO TEXT OR LABELS.`;

        try {
            const { base64: primaryImage } = await aiService.generateImage({ prompt: primaryPrompt });
            if (!primaryImage) throw new Error('Failed to generate primary exercise image');

            // Save Primary as MAIN (for immediate user availability)
            await this.saveAsset(`movement_${baseKey}_main`, primaryImage, { prompt: primaryPrompt, source: 'exercise-job-primary', persona: primaryId });

            // Save Primary with Persona Key
            await this.saveAsset(`movement_${baseKey}_${primaryId}`, primaryImage, { prompt: primaryPrompt, source: 'exercise-job-primary', persona: primaryId });

            // --- 2. GENERATE SECONDARY (Parallel or Sequential) ---
            // User wants "make sure nova images are also created". We'll do it here to ensure it happens.
            console.log(`[JobProcessor] Generating SECONDARY (${secondaryId}) for ${name}`);
            const secondaryPrompt = `Fitness photography of ${name} exercise. Proper form, athletic model (${secondaryCoach.description}), gym setting. ${VITALITY_IMAGE_STYLE}. Action shot, dynamic angle. STRICTLY NO TEXT OR LABELS.`;

            try {
                const { base64: secondaryImage } = await aiService.generateImage({ prompt: secondaryPrompt });
                if (secondaryImage) {
                    await this.saveAsset(`movement_${baseKey}_${secondaryId}`, secondaryImage, { prompt: secondaryPrompt, source: 'exercise-job-secondary', persona: secondaryId });
                }
            } catch (e) {
                console.error(`[JobProcessor] Failed to generate secondary image for ${name}`, e);
                // Non-blocking failure for secondary
            }

            return { assetUrl: primaryImage };

        } catch (e: any) {
            console.error(`[JobProcessor] Primary generation failed:`, e);
            throw e;
        }
    }

    private async saveAsset(key: string, value: string, meta: any) {
        await pool.query(
            `INSERT INTO assets(key, value, asset_type, status, meta, created_at)
             VALUES($1, $2, 'image', 'active', $3::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, meta = EXCLUDED.meta, updated_at = now()`,
            [key, value, JSON.stringify(meta || {})]
        );
    }
}

export const jobProcessor = new JobProcessor();
