import { pool } from './src/infra/db/pool.js';

async function check() {
    try {
        const { rows } = await pool.query("SELECT key FROM cached_assets WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref')");
        console.log("Found keys:", rows.map(r => r.key));
    } catch (e: any) {
        console.error("Error:", e.message);
    } finally {
        await pool.end();
    }
}

check();
