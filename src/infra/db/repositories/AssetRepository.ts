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
        let { value = '', buffer, status, type, metadata = {} } = data;

        // CRITICAL FIX: For JSON types, if buffer is provided but no value, convert buffer to string
        // This ensures meta JSON is properly stored and retrievable
        if (type === 'json' && buffer && buffer.length > 0 && !value) {
            value = buffer.toString('utf-8');
        }

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:33',message:'save entry',data:{keyStr,type,status,hasValue:!!value,valueLength:value?.length||0,hasBuffer:!!buffer,bufferLength:buffer?.length||0,hasMetadata:!!metadata,metadataKeys:Object.keys(metadata||{}),movementId:metadata?.movementId,convertedBufferToValue:type==='json'&&buffer&&buffer.length>0&&!data.value},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'})}).catch(()=>{});
        // #endregion

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

            // 1b. Upsert cached_asset_meta if movement_id is provided in metadata
            if (metadata.movementId) {
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:52',message:'cached_asset_meta insert START',data:{keyStr,movementId:metadata.movementId,type,source:metadata.source},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'})}).catch(()=>{});
                // #endregion
                try {
                    const metaResult = await client.query(`
                        INSERT INTO cached_asset_meta (key, prompt, mode, source, created_by, movement_id, persona, step_index, text_context, text_context_simple)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ON CONFLICT (key) DO UPDATE 
                        SET prompt = COALESCE(EXCLUDED.prompt, cached_asset_meta.prompt),
                            mode = COALESCE(EXCLUDED.mode, cached_asset_meta.mode),
                            source = COALESCE(EXCLUDED.source, cached_asset_meta.source),
                            movement_id = COALESCE(EXCLUDED.movement_id, cached_asset_meta.movement_id),
                            persona = COALESCE(EXCLUDED.persona, cached_asset_meta.persona),
                            step_index = COALESCE(EXCLUDED.step_index, cached_asset_meta.step_index),
                            text_context = COALESCE(EXCLUDED.text_context, cached_asset_meta.text_context),
                            text_context_simple = COALESCE(EXCLUDED.text_context_simple, cached_asset_meta.text_context_simple)
                    `, [
                        keyStr,
                        metadata.prompt || null,
                        metadata.mode || null,
                        metadata.source || null,
                        metadata.created_by || null,
                        metadata.movementId,
                        metadata.persona || null,
                        metadata.stepIndex || null,
                        metadata.textContext || null,
                        metadata.textContextSimple || null
                    ]);
                    // #region agent log
                    fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:70',message:'cached_asset_meta insert SUCCESS',data:{keyStr,movementId:metadata.movementId,rowCount:metaResult.rowCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'})}).catch(()=>{});
                    // #endregion
                } catch (metaError: any) {
                    // Don't fail the whole transaction if meta insert fails
                    console.warn(`[AssetRepository] Failed to insert cached_asset_meta for ${keyStr}: ${metaError.message}`);
                    // #region agent log
                    fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:74',message:'cached_asset_meta insert FAILED',data:{keyStr,movementId:metadata.movementId,error:metaError.message,errorCode:metaError.code},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'})}).catch(()=>{});
                    // #endregion
                }
            } else {
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:78',message:'cached_asset_meta SKIPPED - no movementId',data:{keyStr,type,hasMetadata:!!metadata,metadataKeys:Object.keys(metadata||{})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'})}).catch(()=>{});
                // #endregion
            }

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
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:95',message:'save COMMIT success',data:{keyStr,type,status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H4.1'})}).catch(()=>{});
            // #endregion
        } catch (e: any) {
            await client.query('ROLLBACK');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/cba905b3-6b91-4254-9025-e579b3638d0e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'AssetRepository.ts:99',message:'save ROLLBACK error',data:{keyStr,type,error:e.message,errorStack:e.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H4.1'})}).catch(()=>{});
            // #endregion
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
     * CRITICAL: Joins cached_asset_meta to get text_context fields for backfill checks
     */
    static async findByKey(key: UnifiedKey | string): Promise<AssetRecord | null> {
        const keyStr = key.toString();
        const res = await pool.query(`
            SELECT a.key, a.value, a.status, a.asset_type, a.metadata, a.updated_at, b.data as buffer,
                   m.text_context, m.text_context_simple, m.movement_id, m.persona, m.step_index
            FROM cached_assets a
            LEFT JOIN asset_blob_storage b ON a.key = b.key
            LEFT JOIN cached_asset_meta m ON a.key = m.key
            WHERE a.key = $1
        `, [keyStr]);

        if (res.rows.length === 0) return null;
        
        // Merge cached_asset_meta fields into metadata for consistent access
        const row = res.rows[0];
        if (row.metadata) {
            try {
                const parsed = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                row.metadata = {
                    ...parsed,
                    text_context: row.text_context || parsed.text_context,
                    text_context_simple: row.text_context_simple || parsed.text_context_simple
                };
            } catch {
                row.metadata = {
                    text_context: row.text_context,
                    text_context_simple: row.text_context_simple
                };
            }
        } else {
            row.metadata = {
                text_context: row.text_context,
                text_context_simple: row.text_context_simple
            };
        }
        return row;
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
