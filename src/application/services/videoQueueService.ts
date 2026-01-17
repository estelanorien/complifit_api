
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { AiService } from './aiService.js';

const aiService = new AiService();

export class VideoQueueService {
    private processing = false;
    private intervalId: NodeJS.Timeout | null = null;
    private POLLING_INTERVAL = 5000; // 5 seconds (Video is slower, less frequent)

    constructor() {
        logger.info('[VideoQueue] Initialized');
    }

    start() {
        if (this.intervalId) return;
        logger.info('[VideoQueue] Starting worker...');
        this.intervalId = setInterval(() => this.processNextJob(), this.POLLING_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Enqueue a video generation job.
     * @param assetKey - The key of the asset (usually exercise or meal JSON)
     * @param persona - 'atlas', 'nova', or null for meals
     */
    async enqueue(assetKey: string, persona: string | null = null): Promise<string> {
        try {
            const { rows } = await pool.query(
                `INSERT INTO video_jobs(asset_key, persona, status)
                 VALUES($1, $2, 'pending')
                 RETURNING id`,
                [assetKey, persona]
            );
            logger.info(`[VideoQueue] Job created for ${assetKey} (${persona || 'meal'})`);

            // Set meta status
            await pool.query(
                `UPDATE cached_asset_meta SET video_status = 'pending', video_error = NULL WHERE key = $1`,
                [assetKey]
            );

            setImmediate(() => this.processNextJob());
            return rows[0].id;
        } catch (e: any) {
            logger.error(`[VideoQueue] Failed to enqueue job for ${assetKey}`, e);
            throw e;
        }
    }

    private async processNextJob() {
        if (this.processing) return;

        try {
            this.processing = true;
            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // 1. Lock Job
                const { rows } = await client.query(`
                    SELECT id, asset_key, persona 
                    FROM video_jobs 
                    WHERE status = 'pending'
                    ORDER BY created_at ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                `);

                if (rows.length === 0) {
                    await client.query('ROLLBACK');
                    return;
                }

                const job = rows[0];
                logger.info(`[VideoQueue] Processing job ${job.id} (${job.asset_key})`);

                // Mark Processing
                await client.query(
                    `UPDATE video_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
                    [job.id]
                );

                await client.query(
                    `UPDATE cached_asset_meta SET video_status = 'processing' WHERE key = $1`,
                    [job.asset_key]
                );

                await client.query('COMMIT');

                // 2. Execute Video Generation
                try {
                    const videoUrl = await this.executeVideoGeneration(job.asset_key, job.persona);

                    // Success
                    await pool.query(
                        `UPDATE video_jobs SET status = 'completed', result_url = $1, updated_at = NOW() WHERE id = $2`,
                        [videoUrl, job.id]
                    );

                    // We might want to STORE the video URL in `cached_assets` as a NEW asset (e.g. `..._video_atlas`)?
                    // Or just keep it in `video_jobs`?
                    // Better: Store as a proper asset.
                    const videoKey = `${job.asset_key}_video` + (job.persona ? `_${job.persona}` : '');

                    await pool.query(
                        `INSERT INTO cached_assets(key, value, asset_type, status)
                          VALUES($1, $2, 'video', 'active')
                          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                        [videoKey, videoUrl]
                    );

                    await pool.query(
                        `UPDATE cached_asset_meta SET video_status = 'completed' WHERE key = $1`,
                        [job.asset_key]
                    );
                    logger.info(`[VideoQueue] Job ${job.id} COMPLETED. Video saved to ${videoKey}`);

                } catch (err: any) {
                    logger.error(`[VideoQueue] Job ${job.id} FAILED`, err);

                    await pool.query(
                        `UPDATE video_jobs SET status = 'failed', error_log = $1, updated_at = NOW() WHERE id = $2`,
                        [err.message, job.id]
                    );
                    await pool.query(
                        `UPDATE cached_asset_meta SET video_status = 'failed', video_error = $1 WHERE key = $2`,
                        [err.message, job.asset_key]
                    );
                }

            } catch (err) {
                await client.query('ROLLBACK');
                logger.error('[VideoQueue] Transaction error', err as Error);
            } finally {
                client.release();
            }

        } finally {
            this.processing = false;
        }
    }

    private async executeVideoGeneration(assetKey: string, persona: string | null): Promise<string> {
        // 1. Fetch Context (Exercise Name, Instructions)
        const { rows } = await pool.query(
            `SELECT value, asset_type FROM cached_assets WHERE key = $1`,
            [assetKey]
        );

        if (rows.length === 0) throw new Error("Asset not found");

        const data = JSON.parse(rows[0].value);
        const name = assetKey.split('_').slice(1).join(' '); // Rough name extraction if missing in data
        const subjectName = data.name || name;

        // 2. Construct Prompt
        let prompt = "";
        if (persona) {
            // Exercise Video
            const coachDesc = persona === 'atlas'
                ? "Caucasian male fitness coach, athletic build, short hair"
                : "Caucasian female fitness coach, athletic build, ponytail";

            prompt = `Cinematic 4k fitness shot. ${coachDesc}. Performing perfect form ${subjectName}. Dark gym background, moody lighting. 5 seconds loop.`;
        } else {
            // Meal Prep Video
            prompt = `Cinematic food preparation shot. ${subjectName}. Gourmet 4k cooking video. Steam rising, delicious texture. 5 seconds loop.`;
        }

        // 3. Call AI Service (Veo)
        // Note: AI Service needs a `generateVideo` method. 
        // If it doesn't exist, we'll mock it or add it.
        // Assuming we added it or will add it.

        // For now, let's use the method we saw in `admin.ts`? 
        // `admin.ts` called `fetch(genEndpoint)` directly for Veo.
        // We really should put that in `AiService`.

        return await aiService.generateVideo({ prompt });
    }
}

export const videoQueue = new VideoQueueService();
