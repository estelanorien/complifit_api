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

        const counts = await pool.query(
            "SELECT status, count(*) FROM generation_jobs WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status"
        );
        report.counts = counts.rows;

        const failed = await pool.query(
            "SELECT id, type, error, created_at FROM generation_jobs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 5"
        );
        report.failed = failed.rows;

        const pending = await pool.query(
            "SELECT id, type, status, started_at, created_at FROM generation_jobs WHERE status IN ('PENDING', 'PROCESSING') ORDER BY created_at DESC"
        );
        report.pending = pending.rows;

        fs.writeFileSync('scripts/diag_report.json', JSON.stringify(report, null, 2), 'utf8');
        console.log("Report written to scripts/diag_report.json");

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

run();
