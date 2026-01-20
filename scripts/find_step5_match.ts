
import { pool } from '../src/infra/db/pool.js';

async function main() {
    const res = await pool.query("SELECT key FROM cached_assets WHERE key LIKE 'ex_arnold_press_atlas%'");
    const keys = res.rows.map(r => r.key);
    console.log("Found " + keys.length + " Atlas keys");
    for (const k of keys) {
        if (k.includes("step5") || k.includes("step_5")) {
            console.log("MATCH: " + k);
        }
    }
    process.exit(0);
}
main();
