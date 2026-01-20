
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, status, length(value) as size, updated_at 
            FROM cached_assets 
            WHERE key LIKE 'ex_archer_push_ups_modified%'
            ORDER BY key ASC
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
