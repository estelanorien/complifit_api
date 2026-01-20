
import { pool } from '../src/infra/db/pool.js';
import fs from 'fs';

async function main() {
    const logFile = 'coach_refs_check.txt';
    const log = (msg: string) => fs.appendFileSync(logFile, msg + '\n');
    fs.writeFileSync(logFile, "=== Coach Reference Images Check ===\n");

    try {
        // 1. Check for coach reference images
        const refs = await pool.query(`
            SELECT key, status, length(value) as size_bytes, updated_at 
            FROM cached_assets 
            WHERE key LIKE 'system_coach%'
        `);
        log(`\nFound ${refs.rowCount} coach reference entries:`);
        refs.rows.forEach(r => log(`  - ${r.key}: ${r.status}, ${r.size_bytes} bytes`));

        // 2. Check recent generation jobs
        const jobs = await pool.query(`
            SELECT status, count(*) 
            FROM generation_jobs 
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY status
        `);
        log(`\nJob Status (Last 7 Days):`);
        jobs.rows.forEach(r => log(`  - ${r.status}: ${r.count}`));

        // 3. Check for stuck assets
        const stuck = await pool.query(`
            SELECT key, status, updated_at 
            FROM cached_assets 
            WHERE status = 'generating' 
            AND updated_at < NOW() - INTERVAL '10 minutes'
            LIMIT 10
        `);
        log(`\nStuck Assets (generating for >10 min): ${stuck.rowCount}`);
        stuck.rows.forEach(r => log(`  - ${r.key}`));

        // 4. Check for recent failures
        const failures = await pool.query(`
            SELECT key, status 
            FROM cached_assets 
            WHERE status = 'failed'
            ORDER BY updated_at DESC
            LIMIT 10
        `);
        log(`\nRecent Failed Assets: ${failures.rowCount}`);
        failures.rows.forEach(r => log(`  - ${r.key}`));

        log("\n=== Check Complete ===");
        console.log(fs.readFileSync(logFile, 'utf-8'));

    } catch (e: any) {
        log(`ERROR: ${e.message}`);
    } finally {
        await pool.end();
    }
}
main();
