
import { pool } from '../../infra/db/pool.js';
import { AssetPromptService } from './assetPromptService.ts';

export type EntityType = 'ex' | 'meal';
export type PersonaType = 'atlas' | 'nova' | 'mannequin' | 'none';
export type Subtype = 'main' | 'step' | 'meta' | 'video';

export interface AssetKeyComponents {
    type: EntityType;
    id: string; // Slug or UUID
    persona: PersonaType;
    subtype: Subtype;
    index: number;
}

export class UnifiedAssetService {
    /**
     * Generates a strict deterministic key: type:id:persona:subtype:index
     */
    static generateKey(components: AssetKeyComponents): string {
        const { type, id, persona, subtype, index } = components;
        return `${type}:${id}:${persona}:${subtype}:${index}`;
    }

    /**
     * Parses a deterministic key back into its components.
     */
    static parseKey(key: string): AssetKeyComponents | null {
        const parts = key.split(':');
        if (parts.length !== 5) return null;
        return {
            type: parts[0] as EntityType,
            id: parts[1],
            persona: parts[2] as PersonaType,
            subtype: parts[3] as Subtype,
            index: parseInt(parts[4])
        };
    }

    /**
     * Generates a manifest of all expected asset keys for a given entity.
     */
    static async getManifest(entityType: EntityType, entityId: string, name: string, stepCount: number = 6): Promise<string[]> {
        const keys: string[] = [];
        const slug = AssetPromptService.normalizeToId(name);
        // Use ID if provided and UUID-like, otherwise slug
        const idPart = entityId.length > 20 ? entityId : slug;

        if (entityType === 'ex') {
            // Meta
            keys.push(this.generateKey({ type: 'ex', id: idPart, persona: 'none', subtype: 'meta', index: 0 }));

            // For each persona (Atlas, Nova)
            for (const persona of ['atlas', 'nova'] as PersonaType[]) {
                // Main
                keys.push(this.generateKey({ type: 'ex', id: idPart, persona, subtype: 'main', index: 0 }));
                // Steps
                for (let i = 1; i <= stepCount; i++) {
                    keys.push(this.generateKey({ type: 'ex', id: idPart, persona, subtype: 'step', index: i }));
                }
            }
        } else {
            // Meal
            keys.push(this.generateKey({ type: 'meal', id: idPart, persona: 'none', subtype: 'meta', index: 0 }));
            keys.push(this.generateKey({ type: 'meal', id: idPart, persona: 'none', subtype: 'main', index: 0 }));
            for (let i = 1; i <= stepCount; i++) {
                keys.push(this.generateKey({ type: 'meal', id: idPart, persona: 'none', subtype: 'step', index: i }));
            }
        }


        return keys;
    }

    /**
     * Stores an asset using the split schema:
     * - Metadata in cached_assets
     * - Binary data in asset_blob_storage
     */
    static async storeAsset(
        key: string,
        buffer: Buffer,
        type: 'image' | 'video' | 'json',
        status: 'active' | 'generating' | 'failed' = 'active',
        meta: any = {}
    ) {
        // 1. Upsert Index
        await pool.query(`
            INSERT INTO cached_assets (key, value, asset_type, status, metadata, updated_at)
            VALUES ($1, '', $2, $3, $4, now())
            ON CONFLICT (key) DO UPDATE 
            SET status = EXCLUDED.status, 
                metadata = EXCLUDED.metadata,
                updated_at = now()
        `, [key, type, status, JSON.stringify(meta)]);

        // 2. Upsert Blob (only if we have data)
        if (buffer && buffer.length > 0) {
            await pool.query(`
                INSERT INTO asset_blob_storage (key, data)
                VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
            `, [key, buffer]);
        }
    }

    /**
     * Retrieves an asset, combining metadata and blob data.
     */
    static async getAsset(key: string): Promise<{ key: string, buffer: Buffer | null, meta: any, status: string } | null> {
        const res = await pool.query(`
            SELECT a.key, a.status, a.metadata, b.data
            FROM cached_assets a
            LEFT JOIN asset_blob_storage b ON a.key = b.key
            WHERE a.key = $1
        `, [key]);

        if (res.rows.length === 0) return null;
        const row = res.rows[0];

        return {
            key: row.key,
            status: row.status,
            meta: row.metadata || {},
            buffer: row.data // Postgres returns Buffer for bytea
        };
    }
}
