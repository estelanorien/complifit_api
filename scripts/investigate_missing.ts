
import { pool } from '../src/infra/db/pool.js';

async function main() {
    console.log("=== Investigating Missing Assets ===\n");

    try {
        // 1. Get the latest job
        const jobRes = await pool.query(`
            SELECT id, status, result, error, updated_at 
            FROM generation_jobs 
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        const job = jobRes.rows[0];
        console.log(`Latest Job: ${job.id}`);
        console.log(`Status: ${job.status}`);
        console.log(`Result: ${JSON.stringify(job.result)}`);
        console.log(`Updated At: ${job.updated_at}\n`);

        // 2. Check assets for "archer_push_ups_modified" (the current test case)
        const assetsRes = await pool.query(`
            SELECT key, status, length(value) as size, updated_at 
            FROM cached_assets 
            WHERE key LIKE 'ex_archer_push_ups_modified%'
            ORDER BY key ASC
        `);
        console.log(`Assets matching "ex_archer_push_ups_modified" (${assetsRes.rowCount}):`);
        assetsRes.rows.forEach(r => {
            console.log(`  - ${r.key}: ${r.status}, ${r.size} bytes (${r.updated_at})`);
        });

        // 3. Check for any errors in the meta table
        const metaRes = await pool.query(`
            SELECT key, prompt 
            FROM cached_asset_meta 
            WHERE key LIKE 'ex_archer_push_ups_modified%'
            LIMIT 5
        `);
        console.log(`\nSample Metadata Prompt Structure:`);
        metaRes.rows.forEach(r => {
            console.log(`  - ${r.key}: ${r.prompt.substring(0, 100)}...`);
        });

    } catch (e: any) {
        console.error("Error:", e.message);
    } finally {
        await pool.end();
    }
}
main();
