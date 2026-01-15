import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function test() {
    console.log('Testing connection to:', process.env.DATABASE_URL?.split('@')[1]);
    try {
        const res = await pool.query('SELECT 1 as result');
        console.log('Connection SUCCESS:', res.rows[0]);

        // Check tables
        const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        console.log('Tables:', tables.rows.map(r => r.table_name).join(', '));

        // Check columns of cached_asset_meta
        try {
            const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'cached_asset_meta'");
            console.log('cached_asset_meta columns:', cols.rows.map(r => r.column_name).join(', '));
        } catch (e) {
            console.log('cached_asset_meta does not exist or error checking columns');
        }

    } catch (e) {
        console.error('Connection FAILED:');
        console.error(e);
    } finally {
        await pool.end();
    }
}

test();
