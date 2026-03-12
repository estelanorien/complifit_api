
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        console.log("--- Verifying Database State ---");

        // Check Table
        const tableCheck = await pool.query("SELECT to_regclass('asset_blob_storage') as exists");
        console.log(`Blob Table Exists: ${!!tableCheck.rows[0].exists}`);

        // Check Hard Reset (Should be 0)
        const assetsCount = await pool.query('SELECT COUNT(*) FROM cached_assets');
        console.log(`Cached Assets Count: ${assetsCount.rows[0].count}`);

        const metaCount = await pool.query('SELECT COUNT(*) FROM cached_asset_meta');
        console.log(`Asset Meta Count: ${metaCount.rows[0].count}`);

        // Audit Equipment
        const equipAudit = await pool.query(`
            SELECT COUNT(*) 
            FROM training_exercises 
            WHERE equipment IS NULL 
               OR equipment = '{}' 
               OR array_length(equipment, 1) IS NULL
        `);
        console.log(`Exercises Needing Enrichment: ${equipAudit.rows[0].count}`);

    } catch (e: any) {
        console.error("Verification Failed:", e.message);
    }
    process.exit(0);
}
main();
