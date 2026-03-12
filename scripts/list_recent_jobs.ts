
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        console.log("=== Listing Recent Jobs ===");
        const { rows } = await pool.query(`
            SELECT id, type, status, payload->>'groupName' as group_name, created_at 
            FROM generation_jobs 
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        if (rows.length === 0) {
            console.log("No jobs found in database.");
        } else {
            console.table(rows);
        }
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}
main();
