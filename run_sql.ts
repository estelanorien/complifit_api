
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const sqlFile = process.argv[2];
    if (!sqlFile) {
        console.error("Please provide a SQL file path.");
        process.exit(1);
    }

    const client = await pool.connect();
    try {
        console.log(`Executing ${sqlFile}...`);
        const sql = fs.readFileSync(path.resolve(sqlFile), 'utf8');
        await client.query(sql);
        console.log("Success!");
    } catch (e: any) {
        console.error("Migration failed:", e.message);
    } finally {
        client.release();
        process.exit(0);
    }
}
run();
