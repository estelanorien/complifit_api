
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log("--- DEBUG MANUAL INSERT ---");
    const client = await pool.connect();
    try {
        const key = 'ex_25m_sprint_25m_slow_atlas_main';

        console.log(`Attempting to insert key: ${key}`);

        // Try INSERT
        await client.query(
            `INSERT INTO cached_assets(key, value, asset_type, status)
             VALUES($1, $2, $3, $4)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status`,
            [key, 'debug_value', 'image', 'failed']
        );

        console.log("Insert/Update successful (no throw).");

        // Verify
        const res = await client.query("SELECT * FROM cached_assets WHERE key=$1", [key]);
        if (res.rows.length > 0) {
            console.log("✅ Row verified in DB:", res.rows[0]);
        } else {
            console.log("❌ Row NOT FOUND after insert!");
        }

    } catch (e) {
        console.error("❌ INSERT FAILED:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
