
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        console.log("=== Checking Verification Results from DB ===");

        // 1. Find the recent test job
        const { rows: jobs } = await pool.query(`
            SELECT id, status, result, error, created_at, updated_at 
            FROM generation_jobs 
            WHERE type = 'BATCH_ASSET_GENERATION' 
            AND payload->>'groupName' = 'Test Sequential Move'
            ORDER BY created_at DESC 
            LIMIT 1
        `);

        if (jobs.length === 0) {
            console.error("❌ No test job found!");
            return;
        }

        const job = jobs[0];
        console.log(`\nJob Found: ${job.id}`);
        console.log(`Status: ${job.status}`);
        console.log(`Result: ${JSON.stringify(job.result, null, 2)}`);
        console.log(`Error: ${job.error}`);

        if (job.status === 'COMPLETED') {
            console.log("✅ Job Status is COMPLETED");
        } else {
            console.log(`⚠️ Job Status is ${job.status}`);
        }

        // 2. Check for Assets
        const normalizedId = "test_sequential_move";
        const keysToCheck = [
            `ex_${normalizedId}_atlas_main`,
            `ex_${normalizedId}_nova_main`
        ];

        console.log("\nChecking Assets:");
        let allFound = true;
        for (const key of keysToCheck) {
            const res = await pool.query(`SELECT status, length(value) as size FROM cached_assets WHERE key = $1`, [key]);
            if (res.rowCount > 0) {
                console.log(`✅ Asset found: ${key} [${res.rows[0].status}, Size: ${res.rows[0].size}]`);
            } else {
                console.error(`❌ Asset MISSING: ${key}`);
                allFound = false;
            }
        }

        if (job.status === 'COMPLETED' && allFound) {
            console.log("\nSUCCESS: Pipeline verified.");
        } else {
            console.log("\nFAILURE: Verification failed.");
        }

    } catch (e: any) {
        console.error("Check Failed:", e.message);
    } finally {
        await pool.end();
    }
}

main();
