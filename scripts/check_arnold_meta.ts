
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query(`
            SELECT key, prompt, persona, step_index 
            FROM cached_asset_meta 
            WHERE key LIKE 'ex_arnold_press%'
            ORDER BY key ASC
        `);
        console.log(`Found ${res.rowCount} meta entries:`);
        res.rows.forEach(r => {
            console.log(`${r.key} | ${r.persona} | Step: ${r.step_index}`);
            console.log(`  Prompt: ${r.prompt.substring(0, 150)}...`);
            console.log("---");
        });
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
