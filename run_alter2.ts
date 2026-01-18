
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log("Altering created_by to TEXT...");
        await client.query(`ALTER TABLE cached_asset_meta ALTER COLUMN created_by TYPE TEXT;`);
        console.log("Success!");
    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        process.exit(0);
    }
}
run();
