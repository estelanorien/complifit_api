import { pool } from './src/db/pool.js';

async function checkJobs() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT id, job_type, status, created_at, payload 
            FROM generation_jobs 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
        await pool.end();
    }
}

checkJobs();
