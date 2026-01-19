import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log('Starting Schema Fix on:', process.env.DATABASE_URL?.split('@')[1]);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Fixing cached_assets...');
        try {
            await client.query('ALTER TABLE cached_assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()');
            console.log('Added updated_at to cached_assets');
        } catch (e) {
            console.log('cached_assets fix failed:', e.message);
        }

        console.log('Fixing generation_jobs...');
        try {
            await client.query('ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()');
            console.log('Added updated_at to generation_jobs');
        } catch (e) {
            console.log('generation_jobs fix failed:', e.message);
        }

        console.log('Fixing meals...');
        try {
            await client.query('ALTER TABLE meals ADD COLUMN IF NOT EXISTS video_main text');
            await client.query('ALTER TABLE meals ADD COLUMN IF NOT EXISTS step_videos jsonb DEFAULT \'{}\'::jsonb');
            console.log('Added video columns to meals');
        } catch (e) {
            console.log('meals fix failed:', e.message);
        }

        await client.query('COMMIT');
        console.log('Schema Fix COMPLETED.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Schema Fix FAILED:', e);
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(console.error);
