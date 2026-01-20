
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        console.log("Attempting direct INSERT...");
        const res = await pool.query(
            `INSERT INTO generation_jobs(user_id, type, payload, status) VALUES($1, $2, $3, $4) RETURNING id`,
            ['debug_user', 'BATCH_ASSET_GENERATION', '{"test":true}', 'PENDING']
        );
        console.log("Inserted ID:", res.rows[0].id);
    } catch (e) {
        console.error("Insert failed:", e);
    } finally {
        await pool.end();
    }
}
main();
