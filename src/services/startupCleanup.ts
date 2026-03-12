/**
 * Startup Cleanup Service
 * Runs on server startup to reset stuck assets and stale jobs.
 */

import { pool } from '../infra/db/pool.js';
import { logger } from '../infra/logger.js';

export async function runStartupCleanup(): Promise<void> {
    logger.info('[StartupCleanup] Running cleanup tasks...');

    try {
        // 1. Reset stuck 'generating' assets to 'failed' if stuck for > 30 minutes
        const stuckAssets = await pool.query(`
            UPDATE cached_assets 
            SET status = 'failed', updated_at = NOW()
            WHERE status = 'generating' 
            AND updated_at < NOW() - INTERVAL '30 minutes'
            RETURNING key
        `);

        if (stuckAssets.rowCount && stuckAssets.rowCount > 0) {
            logger.info(`[StartupCleanup] Reset ${stuckAssets.rowCount} stuck assets to 'failed'`, {
                keys: stuckAssets.rows.slice(0, 5).map(r => r.key)
            });
        }

        // 2. Reset jobs stuck in 'PROCESSING' for > 30 minutes back to 'PENDING'
        const stuckJobs = await pool.query(`
            UPDATE generation_jobs 
            SET status = 'PENDING', started_at = NULL, updated_at = NOW()
            WHERE status = 'PROCESSING' 
            AND started_at < NOW() - INTERVAL '30 minutes'
            RETURNING id
        `);

        if (stuckJobs.rowCount && stuckJobs.rowCount > 0) {
            logger.info(`[StartupCleanup] Reset ${stuckJobs.rowCount} stuck jobs to 'PENDING'`, {
                jobIds: stuckJobs.rows.slice(0, 5).map(r => r.id)
            });
        }

        // 3. Reset stuck video_jobs in 'processing' for > 30 minutes
        const stuckVideoJobs = await pool.query(`
            UPDATE video_jobs
            SET status = 'pending', updated_at = NOW()
            WHERE status = 'processing'
            AND updated_at < NOW() - INTERVAL '30 minutes'
            RETURNING id
        `);

        if (stuckVideoJobs.rowCount && stuckVideoJobs.rowCount > 0) {
            logger.info(`[StartupCleanup] Reset ${stuckVideoJobs.rowCount} stuck video jobs to 'pending'`, {
                jobIds: stuckVideoJobs.rows.slice(0, 5).map(r => r.id)
            });
        }

        // 4. Reset localized_videos stuck in transient states for > 30 minutes
        const stuckVideos = await pool.query(`
            UPDATE localized_videos
            SET status = 'FAILED', verification_notes = COALESCE(verification_notes, '') || ' | Reset: stuck in processing during restart'
            WHERE status IN ('PROCESSING', 'VERIFICATION', 'UPLOADING')
            AND created_at < NOW() - INTERVAL '30 minutes'
            RETURNING id
        `);

        if (stuckVideos.rowCount && stuckVideos.rowCount > 0) {
            logger.info(`[StartupCleanup] Reset ${stuckVideos.rowCount} stuck localized_videos to 'FAILED'`, {
                videoIds: stuckVideos.rows.slice(0, 5).map(r => r.id)
            });
        }

        logger.info('[StartupCleanup] Cleanup complete.');

    } catch (e: any) {
        logger.error('[StartupCleanup] Cleanup failed', e);
    }
}
