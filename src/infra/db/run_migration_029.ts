import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

// Use DATABASE_URL environment variable
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const migrationFile = '029_add_phone_to_profiles.sql';
    const migrationPath = path.join('c:/Users/rmkoc/Downloads/vitapp2/vitality_api-main/vitality_api-main/migrations', migrationFile);

    console.log(`Reading migration file: ${migrationPath}`);
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Applying migration 029...');
    try {
        await pool.query(sql);
        console.log('✅ Migration 029 applied successfully.');
    } catch (e: any) {
        console.error('❌ Migration failed:', e.message);
    } finally {
        await pool.end();
    }
}

run();
