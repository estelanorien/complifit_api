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

        logger.info('[StartupCleanup] Cleanup complete.');

    } catch (e: any) {
        logger.error('[StartupCleanup] Cleanup failed', e);
    }
}
