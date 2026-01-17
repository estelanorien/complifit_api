
import { Pool } from 'pg';
const pool = new Pool({
    connectionString: "postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("Searching meta for Jollof...");
        const res = await pool.query(`
        SELECT key, prompt, movement_id, source 
        FROM cached_asset_meta 
        WHERE prompt ILIKE '%jollof%' OR movement_id ILIKE '%jollof%'
    `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

run();
