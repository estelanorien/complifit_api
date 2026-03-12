
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, status, length(value) as size, updated_at 
            FROM cached_assets 
            ORDER BY updated_at DESC
            LIMIT 20
        `);
        console.log("20 Most Recent Assets:");
        res.rows.forEach(r => {
            console.log(`${r.key} | ${r.status} | ${r.size} bytes | ${r.updated_at}`);
        });
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
