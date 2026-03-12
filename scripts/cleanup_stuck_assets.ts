/**
 * One-time Cleanup Script
 * Run this manually to delete all stuck and failed assets from the database.
 * Usage: npx tsx scripts/cleanup_stuck_assets.ts
 */

import { pool } from '../src/infra/db/pool.js';

async function main() {
    console.log("=== Cleanup Stuck Assets ===\n");

    try {
        // 1. Count stuck assets
        const stuckCount = await pool.query(`SELECT COUNT(*) FROM cached_assets WHERE status = 'generating'`);
        console.log(`Stuck 'generating' assets: ${stuckCount.rows[0].count}`);

        // 2. Count failed assets
        const failedCount = await pool.query(`SELECT COUNT(*) FROM cached_assets WHERE status = 'failed'`);
        console.log(`Failed assets: ${failedCount.rows[0].count}`);

        // 3. Reset generating to failed
        const resetResult = await pool.query(`
            UPDATE cached_assets SET status = 'failed', updated_at = NOW() WHERE status = 'generating'
            RETURNING key
        `);
        console.log(`\nReset ${resetResult.rowCount} 'generating' assets to 'failed'.`);

        // 4. DELETE all failed assets (optional - user can comment out if they want to keep for debugging)
        console.log("\nDeleting all 'failed' assets...");
        const deleteResult = await pool.query(`
            DELETE FROM cached_assets WHERE status = 'failed'
            RETURNING key
        `);
        console.log(`Deleted ${deleteResult.rowCount} failed assets.`);

        // 5. Delete associated metadata
        const keysToDelete = deleteResult.rows.map(r => r.key);
        if (keysToDelete.length > 0) {
            await pool.query(`DELETE FROM cached_asset_meta WHERE key = ANY($1)`, [keysToDelete]);
            console.log(`Deleted corresponding metadata entries.`);
        }

        console.log("\n=== Cleanup Complete ===");

    } catch (e: any) {
        console.error("Cleanup failed:", e.message);
    } finally {
        await pool.end();
    }
}

main();
