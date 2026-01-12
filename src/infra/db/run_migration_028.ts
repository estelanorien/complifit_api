import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const { Pool } = pg;

// Find .env in vitality_app-main
const envPath = path.resolve('c:/Users/rmkoc/Downloads/vitapp2/vitality_api-main/vitality_api-main/.env');
dotenv.config({ path: envPath });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const sqlPath = path.join('c:/Users/rmkoc/Downloads/vitapp2/vitality_api-main/vitality_api-main/migrations/028_add_weight_logs.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Running Migration 028...');
    try {
        const start = Date.now();
        await pool.query(sql);
        console.log(`✅ Migration 028 applied successfully in ${Date.now() - start}ms`);
    } catch (err: any) {
        console.error('❌ Migration failed:', err);
        if (err.stack) console.error(err.stack);
    } finally {
        await pool.end();
    }
}

run();
