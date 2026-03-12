import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        const report: any = {};

        // Jobs from the last 6 hours
        const jobs = await pool.query(
            "SELECT id, type, status, error, created_at FROM generation_jobs WHERE created_at > NOW() - INTERVAL '6 hours' ORDER BY created_at DESC"
        );
        report.todayJobs = jobs.rows;

        fs.writeFileSync('scripts/today_report.json', JSON.stringify(report, null, 2), 'utf8');
        console.log("Report written to scripts/today_report.json");

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
