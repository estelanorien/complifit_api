import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("--- FAILED JOBS (Detailed) ---");
        const failed = await pool.query(
            "SELECT id, type, error, created_at FROM generation_jobs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 5"
        );
        failed.rows.forEach(r => {
            console.log(`ID: ${r.id}`);
            console.log(`Type: ${r.type}`);
            console.log(`Error: ${r.error}`);
            console.log(`Created At: ${r.created_at}`);
            console.log("-------------------");
        });

        console.log("\n--- PENDING/PROCESSING JOBS ---");
        const pending = await pool.query(
            "SELECT id, type, status, started_at, created_at FROM generation_jobs WHERE status IN ('PENDING', 'PROCESSING') ORDER BY created_at DESC"
        );
        pending.rows.forEach(r => console.log(r));

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
