import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        const jobId = 'c4374c4e-d9e1-4874-bc4a-97645f65349e';
        const res = await pool.query(
            "SELECT error FROM generation_jobs WHERE id = $1",
            [jobId]
        );
        console.log("JOB_ERROR:");
        console.log(res.rows[0]?.error || "NULL");

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
