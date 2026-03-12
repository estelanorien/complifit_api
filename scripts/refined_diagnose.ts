import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("--- JOB COUNTS BY STATUS ---");
        const counts = await pool.query(
            "SELECT status, count(*) FROM generation_jobs WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status"
        );
        console.table(counts.rows);

        console.log("\n--- LATEST JOBS ---");
        const latest = await pool.query(
            "SELECT id, type, status, started_at, created_at FROM generation_jobs ORDER BY created_at DESC LIMIT 5"
        );
        latest.rows.forEach(r => console.log(r));

        console.log("\n--- LATEST ASSET UPDATES ---");
        const assets = await pool.query(
            "SELECT key, status, updated_at FROM cached_assets ORDER BY updated_at DESC LIMIT 5"
        );
        assets.rows.forEach(r => console.log(r));

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
