
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query("SELECT id, payload, result FROM generation_jobs ORDER BY created_at DESC LIMIT 1");
        const job = res.rows[0];
        console.log(`Job ID: ${job.id}`);
        console.log(`Result: ${JSON.stringify(job.result)}`);
        console.log(`Payload: ${JSON.stringify(job.payload, null, 2)}`);
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
