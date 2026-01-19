import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const OUT_FILE = path.resolve(__dirname, 'debug_output_utf8.txt');

async function run() {
    console.log("--- DEBUG TO FILE ---");
    const client = await pool.connect();
    try {
        const resJobs = await client.query(
            "SELECT id, type, status, result, created_at FROM generation_jobs ORDER BY created_at DESC LIMIT 3"
        );
        const output = JSON.stringify(resJobs.rows, null, 2);
        fs.writeFileSync(OUT_FILE, output, 'utf8');
        console.log("Wrote to " + OUT_FILE);

        // Also check keys
        const resSpecific = await client.query(
            "SELECT key, status FROM cached_assets WHERE key = $1",
            ['ex_25m_sprint_25m_slow_atlas_main']
        );
        fs.appendFileSync(OUT_FILE, "\n\nSpecific Key: " + JSON.stringify(resSpecific.rows));

    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        await pool.end();
    }
}
run();
