import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("Expanding cached_asset_meta schema...");
        await pool.query(`
            ALTER TABLE cached_asset_meta 
            ADD COLUMN IF NOT EXISTS persona TEXT,
            ADD COLUMN IF NOT EXISTS step_index INTEGER,
            ADD COLUMN IF NOT EXISTS text_context TEXT,
            ADD COLUMN IF NOT EXISTS text_context_simple TEXT,
            ADD COLUMN IF NOT EXISTS original_name TEXT
        `);
        console.log("Schema expanded successfully.");
    } catch (e) {
        console.error("Schema expansion failed:", e);
    } finally {
        await pool.end();
    }
}

run();
