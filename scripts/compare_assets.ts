
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const keys = [
            'ex_arnold_press_atlas_step_5', // Displayed
            'ex_arnold_press_atlas_step_3'  // Spinner
        ];

        for (const key of keys) {
            const res = await pool.query("SELECT key, status, length(value) as size, value FROM cached_assets WHERE key = $1", [key]);
            if (res.rowCount > 0) {
                const r = res.rows[0];
                console.log(`Key: ${r.key}`);
                console.log(`Status: ${r.status}`);
                console.log(`Size: ${r.size}`);
                console.log(`Value Preview (100 char): ${r.value.substring(0, 100)}...`);
                console.log(`Value End (50 char): ...${r.value.substring(r.value.length - 50)}`);
                console.log("-------------------");
            } else {
                console.log(`Key: ${key} | NOT FOUND`);
            }
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
