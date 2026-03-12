import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("--- COACH REFERENCES ---");
        const refs = await pool.query(
            "SELECT key, status, length(value) as len FROM cached_assets WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref')"
        );
        console.log(JSON.stringify(refs.rows, null, 2));

        console.log("\n--- RECENT ASSETS & META ---");
        // Look for the last few ex_ assets
        const assets = await pool.query(`
            SELECT a.key, a.status, m.movement_id, m.persona, m.step_index, m.prompt
            FROM cached_assets a
            LEFT JOIN cached_asset_meta m ON a.key = m.key
            WHERE a.key LIKE 'ex_%'
            ORDER BY a.updated_at DESC
            LIMIT 10
        `);
        console.log(JSON.stringify(assets.rows, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
