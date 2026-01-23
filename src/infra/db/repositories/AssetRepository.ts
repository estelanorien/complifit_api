import { pool } from '../pool.js';
import { UnifiedKey } from '../../../domain/UnifiedKey.js';

export interface AssetRecord {
    key: string;
    value: string;
    buffer: Buffer | null;
    status: 'active' | 'generating' | 'failed' | 'rejected' | 'auto';
    asset_type: 'image' | 'video' | 'json';
    metadata: any;
    updated_at: Date;
}

/**
 * AssetRepository - The clean data access layer for all Asset-related operations.
 * Implements the Repository pattern for structural impeccableness.
 */
export class AssetRepository {

    /**
     * Stores or updates an asset and its blob.
     */
    static async save(
        key: UnifiedKey | string,
        data: {
            value?: string;
            buffer?: Buffer;
            status: 'active' | 'generating' | 'failed' | 'rejected';
            type: 'image' | 'video' | 'json';
            metadata?: any;
        }
    ): Promise<void> {
        const keyStr = key.toString();
        const { value = '', buffer, status, type, metadata = {} } = data;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Upsert Metadata & Index
            const metadataResult = await client.query(`
                INSERT INTO cached_assets (key, value, asset_type, status, metadata, updated_at)
                VALUES ($1, $2, $3, $4, $5, now())
                ON CONFLICT (key) DO UPDATE 
                SET value = EXCLUDED.value,
                    status = EXCLUDED.status, 
                    metadata = EXCLUDED.metadata,
                    updated_at = now()
            `, [keyStr, value, type, status, JSON.stringify(metadata)]);

            // 2. Upsert Blob if provided (only for image types that need binary storage)
            // For video and json, we store the value as string, no blob needed
            if (buffer && buffer.length > 0) {
                if (type !== 'image') {
                    // Log warning if buffer provided for non-image type
                    console.warn(`[AssetRepository] Buffer provided for non-image type ${type}. Storing value only.`);
                } else {
                    const blobResult = await client.query(`
                        INSERT INTO asset_blob_storage (key, data)
                        VALUES ($1, $2)
                        ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
                    `, [keyStr, buffer]);
                    
                    // Verify blob was inserted
                    if (blobResult.rowCount === 0) {
                        throw new Error(`Failed to insert blob for key: ${keyStr}`);
                    }
                }
            } else if (type === 'image' && !value) {
                // For images, we should have either buffer or value
                // If neither, log a warning but don't fail (might be updating status only)
                console.warn(`[AssetRepository] No buffer or value provided for image asset: ${keyStr}`);
            }

            await client.query('COMMIT');
        } catch (e: any) {
            await client.query('ROLLBACK');
            // Enhance error message with context
            const enhancedError = new Error(`Failed to save asset ${keyStr}: ${e.message}`);
            (enhancedError as any).originalError = e;
            (enhancedError as any).key = keyStr;
            (enhancedError as any).type = type;
            throw enhancedError;
        } finally {
            client.release();
        }
    }

    /**
     * Retrieves a complete asset record.
     */
    static async findByKey(key: UnifiedKey | string): Promise<AssetRecord | null> {
        const keyStr = key.toString();
        const res = await pool.query(`
            SELECT a.key, a.value, a.status, a.asset_type, a.metadata, a.updated_at, b.data as buffer
            FROM cached_assets a
            LEFT JOIN asset_blob_storage b ON a.key = b.key
            WHERE a.key = $1
        `, [keyStr]);

        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    /**
     * Batch check for existing keys (optimized index search).
     */
    static async checkExists(keys: string[]): Promise<Set<string>> {
        if (keys.length === 0) return new Set();
        const res = await pool.query(
            `SELECT key FROM cached_assets WHERE key = ANY($1) AND status = 'active'`,
            [keys]
        );
        return new Set(res.rows.map(r => r.key));
    }

    /**
     * Deletes assets by prefix (used for re-generation cycles).
     */
    static async deleteByPrefix(prefix: string): Promise<number> {
        const res = await pool.query(
            `DELETE FROM cached_assets WHERE key LIKE $1`,
            [`${prefix}%`]
        );
        return res.rowCount ?? 0;
    }

    /**
     * Gets all keys for a specific movement (id).
     */
    static async findByMovement(movementId: string): Promise<AssetRecord[]> {
        // Since movementId is part of the key type:id:..., we use LIKE
        const res = await pool.query(`
            SELECT a.key, a.value, a.status, a.asset_type, a.metadata, a.updated_at, b.data as buffer
            FROM cached_assets a
            LEFT JOIN asset_blob_storage b ON a.key = b.key
            WHERE a.key LIKE $1
        `, [`%:${movementId}:%`]);

        return res.rows;
    }

    /**
     * Finds assets by type.
     */
    static async findByType(type: 'image' | 'video' | 'json' | string): Promise<AssetRecord[]> {
        const res = await pool.query(`
            SELECT a.key, a.value, a.status, a.asset_type, a.metadata, a.updated_at, b.data as buffer
            FROM cached_assets a
            LEFT JOIN asset_blob_storage b ON a.key = b.key
            WHERE a.asset_type = $1
        `, [type]);

        return res.rows;
    }
}
