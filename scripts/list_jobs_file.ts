
import { pool } from '../src/infra/db/pool.js';
import fs from 'fs';

async function main() {
    try {
        const { rows } = await pool.query(`
            SELECT id, type, status, payload->>'groupName' as group_name, created_at 
            FROM generation_jobs 
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        fs.writeFileSync('recent_jobs.txt', JSON.stringify(rows, null, 2));
    } catch (e) {
        fs.writeFileSync('recent_jobs.txt', "ERROR: " + e.message);
    } finally {
        await pool.end();
    }
}
main();
