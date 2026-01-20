import { pool } from './src/infra/db/pool.js';

async function check() {
    try {
        const result = await pool.query(`
            SELECT key, length(value) as len, status 
            FROM cached_assets 
            WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref');
        `);
        console.log("RESULT_START");
        console.log(JSON.stringify(result.rows));
        console.log("RESULT_END");
    } catch (e: any) {
        console.error("Error:", e.message);
    } finally {
        await pool.end();
    }
}

check();
