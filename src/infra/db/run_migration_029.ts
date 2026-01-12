import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

// Direct connection string for speed
const DATABASE_URL = "postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db";

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
