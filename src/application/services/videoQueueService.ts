
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { AiService } from './aiService.js';
import { videoOrchestrator, Phase2VideoResult } from './VideoOrchestrator.js';

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
     * @param mode - 'phase1' (single clip) or 'phase2' (45-60s multi-angle)
     * @param languages - Languages for Phase 2 TTS (default: ['en'])
     */
    async enqueue(
        assetKey: string,
        persona: string | null = null,
        mode: 'phase1' | 'phase2' = 'phase1',
        languages: string[] = ['en']
    ): Promise<string> {
        try {
            const { rows } = await pool.query(
                `INSERT INTO video_jobs(asset_key, persona, status, mode)
                 VALUES($1, $2, 'pending', $3)
                 RETURNING id`,
                [assetKey, persona, mode]
            );
            logger.info(`[VideoQueue] Job created for ${assetKey} (${persona || 'meal'}, mode=${mode})`);

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

                // 1. Lock Job (include mode column)
                const { rows } = await client.query(`
                    SELECT id, asset_key, persona, COALESCE(mode, 'phase1') as mode
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
                logger.info(`[VideoQueue] Processing job ${job.id} (${job.asset_key}, mode=${job.mode})`);

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

                // 2. Execute Video Generation (route by mode)
                try {
                    if (job.mode === 'phase2') {
                        await this.executePhase2Generation(job.id, job.asset_key, job.persona);
                    } else {
                        await this.executePhase1Generation(job.id, job.asset_key, job.persona);
                    }
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

    /**
     * Phase 1: Single clip via AI service (legacy flow)
     */
    private async executePhase1Generation(jobId: string, assetKey: string, persona: string | null): Promise<void> {
        const videoUrl = await this.executeVideoGeneration(assetKey, persona);

        // Success
        await pool.query(
            `UPDATE video_jobs SET status = 'completed', result_url = $1, updated_at = NOW() WHERE id = $2`,
            [videoUrl, jobId]
        );

        const videoKey = `${assetKey}_video` + (persona ? `_${persona}` : '');

        await pool.query(
            `INSERT INTO cached_assets(key, value, asset_type, status)
              VALUES($1, $2, 'video', 'active')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [videoKey, videoUrl]
        );

        await pool.query(
            `UPDATE cached_asset_meta SET video_status = 'completed' WHERE key = $1`,
            [assetKey]
        );
        logger.info(`[VideoQueue] Phase 1 job ${jobId} COMPLETED. Video saved to ${videoKey}`);
    }

    /**
     * Phase 2: Multi-angle 45-60s video via VideoOrchestrator
     */
    private async executePhase2Generation(jobId: string, assetKey: string, persona: string | null): Promise<void> {
        const coachId = (persona === 'atlas' || persona === 'nova') ? persona : 'atlas';

        // Fetch languages from job metadata or default to English
        const { rows: jobRows } = await pool.query(
            `SELECT transition_type, music_uri FROM video_jobs WHERE id = $1`,
            [jobId]
        );
        const jobMeta = jobRows[0] || {};

        const result: Phase2VideoResult = await videoOrchestrator.executePhase2({
            assetKey,
            coachId,
            languages: ['en'], // Default to English; extend when multi-language queue is implemented
            options: {
                transitionType: jobMeta.transition_type || 'cut',
                musicUri: jobMeta.music_uri || undefined
            }
        });

        if (!result.success) {
            throw new Error(`Phase 2 pipeline failed: ${result.errors?.join(', ') || 'Unknown error'}`);
        }

        // Store the first localized video URL as the result
        const primaryVideo = result.localizedVideos[0];
        const resultUrl = primaryVideo?.gcsPath || null;

        await pool.query(
            `UPDATE video_jobs SET status = 'completed', result_url = $1, updated_at = NOW() WHERE id = $2`,
            [resultUrl, jobId]
        );

        await pool.query(
            `UPDATE cached_asset_meta SET video_status = 'completed' WHERE key = $1`,
            [assetKey]
        );

        logger.info(`[VideoQueue] Phase 2 job ${jobId} COMPLETED`, {
            videoCount: result.localizedVideos.length,
            gcsPath: resultUrl
        });
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
        return await aiService.generateVideo({ prompt });
    }
}

export const videoQueue = new VideoQueueService();
