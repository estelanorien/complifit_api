
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, value 
            FROM cached_assets 
            WHERE key LIKE 'ex_arnold_press_%'
        `);
        for (const r of res.rows) {
            const hasPrefix = r.value.startsWith('data:image');
            console.log(`${r.key} | Prefix: ${hasPrefix} | Start: ${r.value.substring(0, 30)}`);
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
