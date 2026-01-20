
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query("SELECT length(value) as sql_len, value FROM cached_assets WHERE key = 'ex_arnold_press_atlas_step_3'");
        if (res.rowCount > 0) {
            const r = res.rows[0];
            console.log(`SQL Length: ${r.sql_len}`);
            console.log(`JS Length: ${r.value.length}`);
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
