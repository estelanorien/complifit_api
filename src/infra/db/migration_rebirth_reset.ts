/**
 * Migration: Rebirth Reset
 * 
 * This migration:
 * 1. Wipes all cached_assets and asset_blob_storage
 * 2. Restores only Atlas and Nova reference images
 * 3. Creates the new optimized schema for the Repository pattern
 */

import { pool } from './pool.js';
import path from 'path';
import { restoreReferenceImages } from './migration_rebirth_backup.js';

export async function rebirthReset() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        console.log('[Migration] 🔥 Starting Rebirth Reset...');

        // 1. Wipe asset tables
        console.log('[Migration] Truncating cached_assets...');
        await client.query('TRUNCATE TABLE cached_assets CASCADE');

        console.log('[Migration] Truncating asset_blob_storage...');
        await client.query('TRUNCATE TABLE asset_blob_storage CASCADE');

        console.log('[Migration] Truncating cached_asset_meta...');
        await client.query('TRUNCATE TABLE cached_asset_meta CASCADE');

        // 2. Add indexes for the new Repository pattern (if they don't exist)
        console.log('[Migration] Creating optimized indexes...');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_cached_assets_key_status 
            ON cached_assets(key, status)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_cached_assets_status 
            ON cached_assets(status) 
            WHERE status IN ('generating', 'failed')
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_asset_blob_key 
            ON asset_blob_storage(key)
        `);

        // 3. Ensure metadata column has proper GIN index
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_cached_assets_metadata_gin 
            ON cached_assets USING GIN(metadata)
        `);

        console.log('[Migration] ✅ Schema optimizations complete');

        await client.query('COMMIT');

        // 4. Restore reference images
        console.log('[Migration] Restoring reference images...');
        await restoreReferenceImages();

        console.log('[Migration] ✅ Rebirth Reset Complete!');
        console.log('[Migration] Atlas and Nova references have been preserved.');

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[Migration] ❌ Reset failed:', e);
        throw e;
    } finally {
        client.release();
    }
}

import { fileURLToPath } from 'url';
const isDirect = process.argv[1] && (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));

if (isDirect) {
    rebirthReset()
        .then(() => {
            console.log('[Migration] Database is now pristine and ready for the new architecture.');
            process.exit(0);
        })
        .catch((e) => {
            console.error('[Migration] Reset failed:', e);
            process.exit(1);
        });
}
