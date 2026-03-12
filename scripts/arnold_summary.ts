
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, status, length(value) as size 
            FROM cached_assets 
            WHERE key LIKE 'ex_arnold_press_%'
            ORDER BY key ASC
        `);
        console.log(`Found ${res.rowCount} assets:`);
        for (const r of res.rows) {
            console.log(`${r.key} | ${r.status} | ${r.size}`);
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
