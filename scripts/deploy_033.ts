import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Env
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    console.error("DATABASE_URL missing");
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log("Connected to DB. Running 033...");
        const sqlPath = path.resolve(__dirname, '..', 'migrations', '033_add_generation_jobs.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log("Success: 033 applied.");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Failed:", e);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
