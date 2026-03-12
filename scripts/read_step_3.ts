
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query("SELECT value FROM cached_assets WHERE key = 'ex_arnold_press_atlas_step_3'");
        if (res.rowCount > 0) {
            const val = res.rows[0].value;
            console.log(`Length: ${val.length}`);
            console.log(`Content (first 200 chars): ${val.substring(0, 200)}`);
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
