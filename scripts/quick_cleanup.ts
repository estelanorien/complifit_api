/**
 * Quick cleanup - just delete failed assets
 */
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        // Reset generating to failed
        const reset = await pool.query(`UPDATE cached_assets SET status = 'failed' WHERE status = 'generating' RETURNING key`);
        console.log(`Reset ${reset.rowCount} generating assets to failed.`);

        // Delete all failed
        const del = await pool.query(`DELETE FROM cached_assets WHERE status = 'failed' RETURNING key`);
        console.log(`Deleted ${del.rowCount} failed assets.`);

        // Delete orphaned metadata
        const keys = del.rows.map(r => r.key);
        if (keys.length > 0) {
            await pool.query(`DELETE FROM cached_asset_meta WHERE key = ANY($1)`, [keys]);
            console.log(`Cleared metadata.`);
        }

        console.log("Done!");
    } catch (e: any) {
        console.error("Error:", e.message);
    }
    process.exit(0);
}
main();
