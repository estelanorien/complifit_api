import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function diagnose() {
    try {
        const jobs = await pool.query(
            "SELECT id, type, status, error, created_at FROM generation_jobs ORDER BY created_at DESC LIMIT 10"
        );
        console.log("JOBS_START");
        console.log(JSON.stringify(jobs.rows, null, 2));
        console.log("JOBS_END");

        const assets = await pool.query(
            "SELECT key, status, updated_at FROM cached_assets ORDER BY updated_at DESC LIMIT 10"
        );
        console.log("ASSETS_START");
        console.log(JSON.stringify(assets.rows, null, 2));
        console.log("ASSETS_END");

    } catch (e) {
        console.error("Diagnosis failed:", e);
    } finally {
        await pool.end();
    }
}

diagnose();
