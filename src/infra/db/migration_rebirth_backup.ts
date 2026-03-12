/**
 * Migration: Rebirth Backup
 * 
 * This migration:
 * 1. Backs up Atlas and Nova reference images to a safe temp table
 * 2. Can be run before the main reset migration
 */

import { pool } from './pool.js';
import path from 'path';

export async function backupReferenceImages() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        console.log('[Migration] Creating backup table for reference images...');

        // Create temporary backup table
        await client.query(`
            CREATE TABLE IF NOT EXISTS reference_image_backup (
                key TEXT PRIMARY KEY,
                value TEXT,
                asset_type TEXT,
                backed_up_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Backup Atlas reference
        await client.query(`
            INSERT INTO reference_image_backup (key, value, asset_type)
            SELECT key, value, asset_type
            FROM cached_assets
            WHERE key = 'system_coach_atlas_ref'
            ON CONFLICT (key) DO UPDATE 
            SET value = EXCLUDED.value, backed_up_at = NOW()
        `);

        // Backup Nova reference
        await client.query(`
            INSERT INTO reference_image_backup (key, value, asset_type)
            SELECT key, value, asset_type
            FROM cached_assets
            WHERE key = 'system_coach_nova_ref'
            ON CONFLICT (key) DO UPDATE 
            SET value = EXCLUDED.value, backed_up_at = NOW()
        `);

        console.log('[Migration] ✅ Reference images backed up successfully');

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[Migration] ❌ Backup failed:', e);
        throw e;
    } finally {
        client.release();
    }
}

export async function restoreReferenceImages() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        console.log('[Migration] Restoring reference images from backup...');

        // Restore from backup
        await client.query(`
            INSERT INTO cached_assets (key, value, asset_type, status, updated_at)
            SELECT key, value, asset_type, 'active', NOW()
            FROM reference_image_backup
            ON CONFLICT (key) DO UPDATE 
            SET value = EXCLUDED.value, status = 'active', updated_at = NOW()
        `);

        console.log('[Migration] ✅ Reference images restored successfully');

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[Migration] ❌ Restore failed:', e);
        throw e;
    } finally {
        client.release();
    }
}

import { fileURLToPath } from 'url';
const isDirect = process.argv[1] && (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));

if (isDirect) {
    backupReferenceImages()
        .then(() => {
            console.log('[Migration] Backup complete. You can now run the reset migration.');
            process.exit(0);
        })
        .catch((e) => {
            console.error('[Migration] Backup failed:', e);
            process.exit(1);
        });
}
