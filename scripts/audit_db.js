
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log("--- Audit Coach Refs ---");
    const res = await pool.query("SELECT key, length(value) as len, status FROM cached_assets WHERE key LIKE 'system_coach%'");
    console.log(res.rows);

    console.log("\n--- Audit Recent Assets ---");
    const res2 = await pool.query("SELECT key, status, updated_at FROM cached_assets ORDER BY updated_at DESC LIMIT 10");
    console.log(res2.rows);

    await pool.end();
}

run().catch(console.error);
