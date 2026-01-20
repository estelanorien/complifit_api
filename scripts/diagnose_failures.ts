/**
 * Diagnostic script to check recent generation failures
 */

import { pool } from '../src/infra/db/pool.js';

async function main() {
    console.log("=== Recent Generation Failures Diagnostic ===\n");

    try {
        // 1. Check recent jobs
        const jobs = await pool.query(`
            SELECT id, type, status, error, result, 
                   created_at, updated_at
            FROM generation_jobs 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        console.log(`Recent Jobs (${jobs.rowCount}):`);
        jobs.rows.forEach(r => {
            console.log(`  [${r.status}] ${r.type} - ${r.id}`);
            console.log(`    Created: ${r.created_at}`);
            if (r.error) console.log(`    ERROR: ${r.error}`);
            if (r.result) console.log(`    Result: ${JSON.stringify(r.result)}`);
        });

        // 2. Check recent failed assets
        const failed = await pool.query(`
            SELECT key, status, updated_at 
            FROM cached_assets 
            WHERE status = 'failed'
            ORDER BY updated_at DESC
            LIMIT 20
        `);
        console.log(`\nRecent Failed Assets (${failed.rowCount}):`);
        failed.rows.forEach(r => console.log(`  - ${r.key} (${r.updated_at})`));

        // 3. Check if coach refs are valid (non-empty base64)
        const refs = await pool.query(`
            SELECT key, length(value) as size, status
            FROM cached_assets
            WHERE key LIKE 'system_coach%'
        `);
        console.log(`\nCoach References:`);
        refs.rows.forEach(r => {
            const isValid = r.size > 1000;
            console.log(`  - ${r.key}: ${r.size} bytes (${isValid ? 'VALID' : 'EMPTY/CORRUPT'})`);
        });

        // 4. Check for any generating assets stuck right now
        const generating = await pool.query(`
            SELECT key, updated_at 
            FROM cached_assets 
            WHERE status = 'generating'
            LIMIT 10
        `);
        console.log(`\nCurrently Generating (${generating.rowCount}):`);
        generating.rows.forEach(r => console.log(`  - ${r.key} (since ${r.updated_at})`));

        console.log("\n=== Diagnostic Complete ===");

    } catch (e: any) {
        console.error("Diagnostic failed:", e.message);
    } finally {
        await pool.end();
    }
}

main();
