
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, status, length(value) as size, updated_at 
            FROM cached_assets 
            WHERE updated_at > NOW() - INTERVAL '1 hour'
            ORDER BY updated_at DESC
        `);
        console.log("Found " + res.rowCount + " assets updated in the last hour:");
        res.rows.forEach(r => {
            console.log(`${r.key} | ${r.status} | ${r.size} bytes | ${r.updated_at}`);
        });
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
