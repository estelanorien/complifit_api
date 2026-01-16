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

        console.log('Adding Video Columns to Exercises...');
        try { await client.query('ALTER TABLE training_exercises ADD COLUMN IF NOT EXISTS video_atlas text'); } catch (e) { console.log('video_atlas error:', e.message); }
        try { await client.query('ALTER TABLE training_exercises ADD COLUMN IF NOT EXISTS video_nova text'); } catch (e) { console.log('video_nova error:', e.message); }

        console.log('Adding Video Columns to Meals...');
        try { await client.query('ALTER TABLE meals ADD COLUMN IF NOT EXISTS video_main text'); } catch (e) { console.log('video_main error:', e.message); }
        try { await client.query('ALTER TABLE meals ADD COLUMN IF NOT EXISTS step_videos jsonb DEFAULT \'{}\'::jsonb'); } catch (e) { console.log('step_videos error:', e.message); }

        console.log('Done.');
    } finally {
        client.release();
        await pool.end();
    }
}
run().catch(console.error);
