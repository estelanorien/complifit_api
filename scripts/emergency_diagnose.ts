import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function diagnose() {
    try {
        console.log("--- GENERATION JOBS (last 5) ---");
        const jobs = await pool.query(
            "SELECT id, type, status, error, created_at, started_at, updated_at FROM generation_jobs ORDER BY created_at DESC LIMIT 5"
        );
        console.table(jobs.rows);

        console.log("\n--- RECENT ASSETS (last 5) ---");
        const assets = await pool.query(
            "SELECT key, asset_type, status, updated_at FROM cached_assets ORDER BY updated_at DESC LIMIT 5"
        );
        console.table(assets.rows);

        console.log("\n--- STUCK JOBS COUNT ---");
        const stuck = await pool.query(
            "SELECT count(*) FROM generation_jobs WHERE status IN ('PENDING', 'PROCESSING')"
        );
        console.log("Count:", stuck.rows[0].count);

        console.log("\n--- FAILED JOBS WITH ERRORS ---");
        const failed = await pool.query(
            "SELECT type, error, count(*) FROM generation_jobs WHERE status = 'FAILED' GROUP BY type, error LIMIT 5"
        );
        console.table(failed.rows);

    } catch (e) {
        console.error("Diagnosis failed:", e);
    } finally {
        await pool.end();
    }
}

diagnose();
