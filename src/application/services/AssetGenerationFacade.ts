import { pool } from '../../infra/db/pool.js';
import { AssetOrchestrator } from './AssetOrchestrator.js';
import { UnifiedAssetService } from './UnifiedAssetService.js';
import { AssetPromptService } from './assetPromptService.js';

export interface GenerationResult {
    success: boolean;
    entityId: string;
    entityType: 'ex' | 'meal';
    assetsGenerated: number;
    assetsFailed: number;
    errors: string[];
    stepCount: number;
}

export interface BatchResult {
    totalItems: number;
    completed: number;
    failed: number;
    results: GenerationResult[];
}

export interface BatchOptions {
    sequential?: boolean;
    delayMs?: number;
    onProgress?: (current: number, total: number, currentItem: string) => void;
}

/**
 * AssetGenerationFacade - Single Entry Point for All Asset Generation
 * 
 * This facade provides a unified interface for:
 * - Admin batch generation
 * - On-demand user plan generation
 * - CLI seeding scripts
 * 
 * It ensures:
 * - Consistent schema usage
 * - Proper error handling
 * - Transaction safety
 * - Progress tracking
 */
export class AssetGenerationFacade {

    /**
     * Generate all assets for a single entity (exercise or meal)
     * This is the core method that handles the complete generation pipeline
     */
    static async generateForEntity(
        type: 'ex' | 'meal',
        id: string
    ): Promise<GenerationResult> {
        const result: GenerationResult = {
            success: false,
            entityId: id,
            entityType: type,
            assetsGenerated: 0,
            assetsFailed: 0,
            errors: [],
            stepCount: 0
        };

        try {
            // 1. Fetch entity from database to validate it exists
            const entityTable = type === 'ex' ? 'training_exercises' : 'meals';
            const entityRes = await pool.query(
                `SELECT id, name FROM ${entityTable} WHERE id = $1`,
                [id]
            );

            if (entityRes.rows.length === 0) {
                result.errors.push(`Entity not found: ${type}:${id}`);
                return result;
            }

            const entity = entityRes.rows[0];
            const entityName = entity.name;

            console.log(`[Facade] Generating assets for ${type}: ${entityName} (${id})`);

            // 2. Generate metadata first to get actual step count
            const metaKey = UnifiedAssetService.generateKey({
                type,
                id,
                persona: 'none',
                subtype: 'meta',
                index: 0
            });

            let stepCount = 6; // Default
            let metaGenerated = false;

            try {
                const metaResult = await AssetOrchestrator.generateAssetForKey(metaKey, false);
                if (metaResult === 'SUCCESS' || metaResult === 'EXISTS') {
                    metaGenerated = true;

                    // Fetch the generated meta to get actual step count
                    const metaAsset = await UnifiedAssetService.getAsset(metaKey);
                    if (metaAsset?.buffer) {
                        const metaData = JSON.parse(metaAsset.buffer.toString());
                        if (metaData.instructions && Array.isArray(metaData.instructions)) {
                            stepCount = metaData.instructions.length;
                            result.stepCount = stepCount;
                            console.log(`[Facade] Meta generated with ${stepCount} steps`);
                        }
                    }
                }
            } catch (e: any) {
                result.errors.push(`Meta generation failed: ${e.message}`);
                // Continue anyway with default step count
            }

            // 3. Build dynamic manifest based on actual step count
            const manifest = await UnifiedAssetService.getManifest(type, id, entityName, stepCount);
            console.log(`[Facade] Manifest has ${manifest.length} assets`);

            // 4. Generate all assets
            for (const key of manifest) {
                try {
                    const assetResult = await AssetOrchestrator.generateAssetForKey(key, false);
                    if (assetResult === 'SUCCESS') {
                        result.assetsGenerated++;
                    } else if (assetResult === 'FAILED') {
                        result.assetsFailed++;
                        result.errors.push(`Failed: ${key}`);
                    }
                    // EXISTS is not counted as generated or failed
                } catch (e: any) {
                    result.assetsFailed++;
                    result.errors.push(`Error generating ${key}: ${e.message}`);
                }
            }

            // 5. Mark as success if at least meta was generated
            result.success = metaGenerated && result.assetsFailed < manifest.length;

            console.log(`[Facade] Complete: ${result.assetsGenerated} generated, ${result.assetsFailed} failed`);

        } catch (e: any) {
            result.errors.push(`Fatal error: ${e.message}`);
            console.error(`[Facade] Fatal error for ${type}:${id}:`, e);
        }

        return result;
    }

    /**
     * Generate assets for multiple entities in batch
     */
    static async generateBatch(
        items: Array<{ type: 'ex' | 'meal', id: string }>,
        options: BatchOptions = {}
    ): Promise<BatchResult> {
        const {
            sequential = true,
            delayMs = 2000,
            onProgress
        } = options;

        const batchResult: BatchResult = {
            totalItems: items.length,
            completed: 0,
            failed: 0,
            results: []
        };

        console.log(`[Facade] Starting batch generation: ${items.length} items`);

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            if (onProgress) {
                onProgress(i + 1, items.length, `${item.type}:${item.id}`);
            }

            const result = await this.generateForEntity(item.type, item.id);
            batchResult.results.push(result);

            if (result.success) {
                batchResult.completed++;
            } else {
                batchResult.failed++;
            }

            // Rate limiting
            if (sequential && i < items.length - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        console.log(`[Facade] Batch complete: ${batchResult.completed}/${batchResult.totalItems} successful`);

        return batchResult;
    }

    /**
     * Ensure assets exist for an entity (used by on-demand generation)
     * This is fire-and-forget - doesn't block if generation fails
     */
    static async ensureAssets(type: 'ex' | 'meal', id: string): Promise<void> {
        // Fire and forget - don't await
        this.generateForEntity(type, id).catch(e => {
            console.error(`[Facade] Background generation failed for ${type}:${id}:`, e);
        });
    }

    /**
     * Check asset status for an entity
     */
    static async getAssetStatus(type: 'ex' | 'meal', id: string): Promise<{
        total: number;
        complete: number;
        failed: number;
        empty: number;
    }> {
        const entityTable = type === 'ex' ? 'training_exercises' : 'meals';
        const entityRes = await pool.query(
            `SELECT name FROM ${entityTable} WHERE id = $1`,
            [id]
        );

        if (entityRes.rows.length === 0) {
            return { total: 0, complete: 0, failed: 0, empty: 0 };
        }

        const manifest = await UnifiedAssetService.getManifest(type, id, entityRes.rows[0].name, 8);

        let complete = 0;
        let failed = 0;
        let empty = 0;

        for (const key of manifest) {
            const asset = await UnifiedAssetService.getAsset(key);
            if (!asset) {
                empty++;
            } else if (asset.status === 'failed') {
                failed++;
            } else if (asset.status === 'active' && asset.buffer && asset.buffer.length > 0) {
                complete++;
            } else {
                empty++;
            }
        }

        return {
            total: manifest.length,
            complete,
            failed,
            empty
        };
    }
}
