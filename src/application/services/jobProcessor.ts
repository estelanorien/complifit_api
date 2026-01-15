import { pool } from '../../infra/db/pool.js';
import { AiService } from './aiService.js';
import { cacheAsset } from './assetService.js'; // Assuming you have an assetService, if not we will query DB directly

const aiService = new AiService();

type JobType = 'MEAL_PLAN' | 'IMAGE' | 'MEAL_DETAILS';

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
            // case 'MEAL_PLAN': return this.handleMealPlanJob(payload);
            default:
                throw new Error(`Unknown job type: ${type}`);
        }
    }

    private async handleImageJob(payload: any): Promise<any> {
        const { prompt, cacheKey, meta } = payload;

        // Call existing AI service
        const { image } = await aiService.generateImage({ prompt }); // Assuming base64 response

        if (!image) throw new Error('AI generation returned no image');

        // PERSISTENCE: Save to assets table immediately
        if (cacheKey) {
            // We can replicate logic from 'application/services/assetService' or call it if available.
            // Assuming we need to insert directly if we don't migrate assetService fully yet.
            await pool.query(
                `INSERT INTO assets(key, value, asset_type, status, meta, created_at)
             VALUES($1, $2, 'image', 'active', $3::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, meta = EXCLUDED.meta, updated_at = now()`,
                [cacheKey, image, JSON.stringify(meta || {})]
            );
        }

        return { assetUrl: image }; // Return same base64 for immediate UI use if needed
    }
}

export const jobProcessor = new JobProcessor();
