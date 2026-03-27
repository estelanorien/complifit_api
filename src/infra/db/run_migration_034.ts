import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration034() {
    const sqlPath = path.join('c:/Users/rmkoc/Downloads/vitapp2/vitality_api-main/vitality_api-main/migrations/034_drop_redundant_log_columns.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Applying 034_drop_redundant_log_columns.sql...');
    try {
        await pool.query(sql);
        console.log('✅ Migration applied successfully!');
    } catch (err: any) {
        console.error('❌ Migration failed:', err.message);
    }

    await pool.end();
}

runMigration034();
