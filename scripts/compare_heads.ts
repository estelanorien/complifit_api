
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res3 = await pool.query("SELECT value FROM cached_assets WHERE key = 'ex_arnold_press_atlas_step_3'");
        const res5 = await pool.query("SELECT value FROM cached_assets WHERE key = 'ex_arnold_press_atlas_step_5'");

        if (res3.rowCount > 0 && res5.rowCount > 0) {
            console.log("Step 3 (93KB): " + res3.rows[0].value.substring(0, 500));
            console.log("\n-------------------\n");
            console.log("Step 5 (104KB): " + res5.rows[0].value.substring(0, 500));
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
