
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const tables = ['cached_assets', 'cached_asset_meta'];
    for (const t of tables) {
        console.log(`--- ${t} ---`);
        const res = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${t}'`);
        console.log(JSON.stringify(res.rows, null, 2));
    }
    await pool.end();
}

run().catch(console.error);
