import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("--- METADATA HARDENING CHECK ---");
        const recentMeta = await pool.query(`
            SELECT key, movement_id, persona, step_index, text_context, source
            FROM cached_asset_meta
            ORDER BY created_at DESC
            LIMIT 5
        `);
        console.log("Recent Meta Entries:");
        recentMeta.rows.forEach(r => console.log(`- ${r.key}: move=${r.movement_id}, pers=${r.persona}, step=${r.step_index}, source=${r.source}`));

        console.log("\n--- INSTRUCTION STEP COUNT CHECK ---");
        // Let's find a meta asset (JSON) and see how many steps it has
        const metaAssets = await pool.query(`
            SELECT key, value FROM cached_assets 
            WHERE key LIKE '%_meta' AND asset_type = 'json'
            ORDER BY updated_at DESC
            LIMIT 3
        `);

        for (const row of metaAssets.rows) {
            try {
                const data = JSON.parse(row.value);
                const steps = data.instructions || data.steps || [];
                console.log(`- ${row.key}: Found ${steps.length} steps.`);
            } catch (e) {
                console.log(`- ${row.key}: Failed to parse JSON.`);
            }
        }

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
