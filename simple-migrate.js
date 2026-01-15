import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for cloud DB
});

async function run() {
    console.log('Connecting to Cloud DB...');
    const client = await pool.connect();
    try {
        console.log('Adding persona...');
        try { await client.query('ALTER TABLE cached_asset_meta ADD COLUMN persona text'); } catch (e) { console.log('persona exists or error:', e.message); }

        console.log('Adding step_index...');
        try { await client.query('ALTER TABLE cached_asset_meta ADD COLUMN step_index int'); } catch (e) { console.log('step_index exists or error:', e.message); }

        console.log('Done.');
    } finally {
        client.release();
        await pool.end();
    }
}
run().catch(console.error);
