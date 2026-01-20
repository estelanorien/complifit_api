
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, status, length(value) as size, updated_at 
            FROM cached_assets 
            WHERE key LIKE 'ex_arnold_press%'
            ORDER BY key ASC
        `);
        console.log("Found " + res.rowCount + " Arnold Press assets:");
        res.rows.forEach(r => {
            console.log(`${r.key} | ${r.status} | ${r.size} bytes | ${r.updated_at}`);
        });
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
