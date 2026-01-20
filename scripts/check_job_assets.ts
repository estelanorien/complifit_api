
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const jobRes = await pool.query("SELECT id, result FROM generation_jobs ORDER BY created_at DESC LIMIT 1");
        const job = jobRes.rows[0];
        console.log(`Job ID: ${job.id}`);

        const assetsRes = await pool.query(`
            SELECT key, status, length(value) as size 
            FROM cached_assets 
            WHERE key LIKE 'ex_archer_push_ups_modified%'
            ORDER BY key ASC
        `);

        console.log("Key | Status | Size");
        assetsRes.rows.forEach(r => {
            console.log(`${r.key} | ${r.status} | ${r.size}`);
        });
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
