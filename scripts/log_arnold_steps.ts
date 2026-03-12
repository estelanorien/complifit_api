
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const res = await pool.query("SELECT value FROM cached_assets WHERE key = 'ex_arnold_press_meta'");
        if (res.rows.length > 0) {
            const meta = JSON.parse(res.rows[0].value);
            const steps = meta.instructions || meta.steps || [];
            console.log(`FOUND ${steps.length} STEPS`);
            steps.forEach((s: any, i: number) => {
                console.log(`STEP ${i + 1}: ${s.label} | ${s.instruction || s.detailed}`);
            });
        }
    } catch (e: any) {
        console.error(e.message);
    }
    process.exit(0);
}
main();
