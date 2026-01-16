import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const filename = process.argv[2];
    if (!filename) {
        console.error('Usage: node scripts/run-named-migration.js <migration_file_name>');
        process.exit(1);
    }

    const migrationPath = path.join(__dirname, '../migrations', filename);
    if (!fs.existsSync(migrationPath)) {
        console.error(`Migration file not found: ${migrationPath}`);
        process.exit(1);
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');
    console.log(`Running migration: ${filename} on ${process.env.DATABASE_URL?.split('@')[1]}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log('✅ Migration completed successfully!');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Migration FAILED:');
        console.error(e.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(console.error);
