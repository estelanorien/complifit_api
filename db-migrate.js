import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    console.log('Starting DB migration on:', process.env.DATABASE_URL?.split('@')[1]);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Ensuring cached_assets exists...');
        await client.query(`
      CREATE TABLE IF NOT EXISTS cached_assets (
        key text PRIMARY KEY,
        value text NOT NULL,
        asset_type text CHECK (asset_type IN ('image', 'video', 'json')) DEFAULT 'json',
        status text CHECK (status IN ('active', 'draft', 'auto')) DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

        console.log('Ensuring cached_asset_meta exists...');
        await client.query(`
      CREATE TABLE IF NOT EXISTS cached_asset_meta (
        key text PRIMARY KEY REFERENCES cached_assets(key) ON DELETE CASCADE,
        prompt text,
        mode text,
        source text,
        created_by uuid,
        movement_id text,
        created_at timestamptz DEFAULT now()
      )
    `);

        console.log('Adding persona column...');
        try {
            await client.query('ALTER TABLE cached_asset_meta ADD COLUMN persona text');
        } catch (e) {
            console.log('Persona column might already exist or error:', e.message);
        }

        console.log('Adding step_index column...');
        try {
            await client.query('ALTER TABLE cached_asset_meta ADD COLUMN step_index int');
        } catch (e) {
            console.log('Step_index column might already exist or error:', e.message);
        }

        await client.query('COMMIT');
        console.log('Migration COMPLETED.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration FAILED CRITICALLY:');
        console.error('Message:', e.message);
        console.error('Stack:', e.stack);
        if (e.detail) console.error('Detail:', e.detail);
        if (e.hint) console.error('Hint:', e.hint);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
