
import { pool } from '../src/infra/db/pool';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    console.log('Clearing image assets from cache...');
    try {
        await pool.query("DELETE FROM cached_assets WHERE asset_type = 'image'");
        console.log('Successfully deleted all cached images.');
    } catch (e) {
        console.error('Error clearing cache:', e);
    } finally {
        process.exit(0);
    }
}

run();
