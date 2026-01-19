
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log("--- CLEANING FAILED ASSETS ---");
    const client = await pool.connect();
    try {
        // Delete all assets with Status = 'failed'
        const resFailed = await client.query("DELETE FROM cached_assets WHERE status = 'failed'");
        console.log(`🗑️ Deleted ${resFailed.rowCount} 'failed' assets.`);

        // Delete all assets with Status = 'generating' (Stuck jobs)
        // Only if older than 5 minutes to be safe, but actually let's nuke all to unstick UI
        const resStuck = await client.query("DELETE FROM cached_assets WHERE status = 'generating'");
        console.log(`🗑️ Deleted ${resStuck.rowCount} 'generating' assets.`);

        console.log("✅ Cleanup Complete. System ready for regeneration.");
    } catch (e) {
        console.error("DEBUG ERROR:", e);
    } finally {
        client.release();
        await pool.end();
        console.log("--- END ---");
    }
}

run();
