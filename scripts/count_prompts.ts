
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT COUNT(DISTINCT prompt) as unique_prompts, COUNT(*) as total
            FROM cached_asset_meta 
            WHERE key LIKE 'ex_arnold_press%'
        `);
        console.log(`Total Arnold Meta: ${res.rows[0].total}`);
        console.log(`Unique Prompts: ${res.rows[0].unique_prompts}`);
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
