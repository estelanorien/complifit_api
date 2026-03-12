
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query("SELECT metadata FROM training_exercises WHERE name ILIKE '%Arnold Press%' LIMIT 1");
        if (res.rows.length === 0) {
            console.log("ARNOLD_NOT_FOUND");
        } else {
            console.log(JSON.stringify(res.rows[0].metadata || {}, null, 2));
        }
    } catch (e: any) {
        console.error("Query Failed:", e.message);
    }
    process.exit(0);
}
main();
