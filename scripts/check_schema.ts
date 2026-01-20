import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        // Check asset-related tables
        const tables = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE '%asset%' 
            ORDER BY table_name
        `);

        console.log('=== ASSET TABLES ===');
        console.log(JSON.stringify(tables.rows, null, 2));

        // Check cached_assets schema
        const cachedAssetsSchema = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'cached_assets'
            ORDER BY ordinal_position
        `);

        console.log('\n=== cached_assets SCHEMA ===');
        console.log(JSON.stringify(cachedAssetsSchema.rows, null, 2));

        // Check if asset_blob_storage exists
        const blobStorage = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'asset_blob_storage'
            ORDER BY ordinal_position
        `);

        console.log('\n=== asset_blob_storage SCHEMA ===');
        console.log(JSON.stringify(blobStorage.rows, null, 2));

    } catch (e: any) {
        console.error('Error:', e.message);
    }
    process.exit(0);
}

main();
