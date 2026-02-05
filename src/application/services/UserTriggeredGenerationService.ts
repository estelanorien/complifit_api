/**
 * UserTriggeredGenerationService - Optimized generation for user interactions
 *
 * When a user clicks on an exercise or meal, this service:
 * 1. Checks if preferred coach's main image exists → returns immediately if found
 * 2. If not, generates ONLY the preferred coach's main image (fast path)
 * 3. Queues the full pipeline in background (steps, secondary coach, videos, translations)
 * 4. Returns quickly to the user with the primary image
 *
 * Goal: User sees an image within seconds, not minutes.
 */

import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { AssetPromptService } from './assetPromptService.js';
import { UnifiedAssetService, EntityType, PersonaType } from './UnifiedAssetService.js';
import { AiService } from './aiService.js';
import { unifiedGenerationPipeline } from './UnifiedGenerationPipeline.js';
import { identityVerificationService } from './IdentityVerificationService.js';
import { withRetry } from './RetryManager.js';

// ============================================================================
// Types
// ============================================================================

export interface UserGenerationRequest {
    userId: string;
    entityType: EntityType;
    entityName: string;
    entityId?: string;           // Optional UUID if known
    preferredCoach: 'atlas' | 'nova';
}

export interface UserGenerationResult {
    found: boolean;              // Was an existing image found?
    generated: boolean;          // Was a new image generated?
    primaryImageUrl: string | null;
    secondaryImageUrl: string | null;  // Other coach if available
    pipelineJobId: string | null;      // For tracking background pipeline
    error?: string;
}

// ============================================================================
// UserTriggeredGenerationService Class
// ============================================================================

export class UserTriggeredGenerationService {
    private static instance: UserTriggeredGenerationService;
    private aiService: AiService;

    private constructor() {
        this.aiService = new AiService();
    }

    static getInstance(): UserTriggeredGenerationService {
        if (!UserTriggeredGenerationService.instance) {
            UserTriggeredGenerationService.instance = new UserTriggeredGenerationService();
        }
        return UserTriggeredGenerationService.instance;
    }

    // ------------------------------------------------------------------------
    // Main Method: Generate for User
    // ------------------------------------------------------------------------

    /**
     * Generate or retrieve assets for a user interaction.
     * Optimized for speed - returns as quickly as possible.
     */
    async generateForUser(request: UserGenerationRequest): Promise<UserGenerationResult> {
        const startTime = Date.now();
        const slug = AssetPromptService.normalizeToId(request.entityName);
        const entityKey = `${request.entityType}:${slug}`;

        logger.info(`[UserGen] User ${request.userId} requested ${entityKey} (prefer: ${request.preferredCoach})`);

        const result: UserGenerationResult = {
            found: false,
            generated: false,
            primaryImageUrl: null,
            secondaryImageUrl: null,
            pipelineJobId: null
        };

        try {
            // Step 1: Check for existing preferred coach image
            const preferredKey = `${entityKey}:${request.preferredCoach}:main:0`;
            const preferredAsset = await AssetRepository.findByKey(preferredKey);

            if (preferredAsset && preferredAsset.status === 'active' && (preferredAsset.buffer || preferredAsset.value)) {
                result.found = true;
                result.primaryImageUrl = this.assetToDataUrl(preferredAsset);
                logger.info(`[UserGen] Found existing ${request.preferredCoach} image for ${entityKey} (${Date.now() - startTime}ms)`);

                // Also check for secondary coach
                const secondaryCoach = request.preferredCoach === 'atlas' ? 'nova' : 'atlas';
                const secondaryKey = `${entityKey}:${secondaryCoach}:main:0`;
                const secondaryAsset = await AssetRepository.findByKey(secondaryKey);
                if (secondaryAsset && secondaryAsset.status === 'active') {
                    result.secondaryImageUrl = this.assetToDataUrl(secondaryAsset);
                }

                // Queue background pipeline to fill any gaps (low priority)
                result.pipelineJobId = await this.queueBackgroundPipeline(request, 'LOW');
                return result;
            }

            // Step 2: Check for secondary coach image as fallback
            if (request.entityType === 'ex') {
                const secondaryCoach = request.preferredCoach === 'atlas' ? 'nova' : 'atlas';
                const secondaryKey = `${entityKey}:${secondaryCoach}:main:0`;
                const secondaryAsset = await AssetRepository.findByKey(secondaryKey);

                if (secondaryAsset && secondaryAsset.status === 'active' && (secondaryAsset.buffer || secondaryAsset.value)) {
                    // Have secondary, can use as fallback while generating primary
                    result.secondaryImageUrl = this.assetToDataUrl(secondaryAsset);
                    logger.info(`[UserGen] Using ${secondaryCoach} as fallback while generating ${request.preferredCoach}`);
                }
            }

            // Step 3: Generate primary image (fast path)
            logger.info(`[UserGen] Generating ${request.preferredCoach} main image for ${entityKey}`);

            const imageResult = await this.generatePrimaryImage(request, entityKey, preferredKey);
            if (imageResult.success) {
                result.generated = true;
                result.primaryImageUrl = imageResult.imageUrl;
                logger.info(`[UserGen] Generated ${request.preferredCoach} main in ${Date.now() - startTime}ms`);
            } else {
                result.error = imageResult.error;
                // If generation failed but we have secondary, that's OK
                if (result.secondaryImageUrl) {
                    result.primaryImageUrl = result.secondaryImageUrl;
                    result.secondaryImageUrl = null;
                }
            }

            // Step 4: Queue full pipeline in background (high priority since user is waiting)
            result.pipelineJobId = await this.queueBackgroundPipeline(request, 'MEDIUM');

        } catch (error: any) {
            logger.error(`[UserGen] Error for ${entityKey}: ${error.message}`);
            result.error = error.message;
        }

        logger.info(`[UserGen] Completed for ${entityKey}: found=${result.found}, generated=${result.generated}, ${Date.now() - startTime}ms`);
        return result;
    }

    // ------------------------------------------------------------------------
    // Fast Image Generation
    // ------------------------------------------------------------------------

    /**
     * Generate just the primary main image - optimized for speed
     */
    private async generatePrimaryImage(
        request: UserGenerationRequest,
        entityKey: string,
        assetKey: string
    ): Promise<{ success: boolean; imageUrl: string | null; error?: string }> {
        try {
            // Get reference image
            const refKey = request.preferredCoach === 'atlas' ? 'system_coach_atlas_ref' : 'system_coach_nova_ref';
            const refAsset = await AssetRepository.findByKey(refKey);

            let referenceImage: string | undefined;
            if (refAsset) {
                if (refAsset.buffer && refAsset.buffer.length > 0) {
                    referenceImage = `data:image/png;base64,${refAsset.buffer.toString('base64')}`;
                } else if (refAsset.value) {
                    referenceImage = refAsset.value.startsWith('data:') ? refAsset.value : `data:image/png;base64,${refAsset.value}`;
                }
            }

            if (!referenceImage && request.entityType === 'ex') {
                logger.warn(`[UserGen] No reference image for ${request.preferredCoach}, generation may have inconsistent identity`);
            }

            // Build prompt
            const { prompt, referenceType } = await AssetPromptService.constructPrompt({
                key: assetKey,
                groupName: request.entityName,
                groupType: request.entityType === 'ex' ? 'exercise' : 'meal',
                subtype: 'main',
                label: `main image for ${request.entityName}`,
                type: 'image'
            });

            // Generate with retry (but limited retries for speed)
            const { base64 } = await withRetry(
                async () => {
                    return this.aiService.generateImage({
                        prompt,
                        referenceImage,
                        referenceType: referenceType as 'identity' | 'environment'
                    });
                },
                'image',
                assetKey,
                { maxAttempts: 2 }  // Limited retries for speed
            );

            if (!base64) {
                throw new Error('No image data returned');
            }

            // Quick identity check (non-blocking - don't fail if verification says retry)
            let identityVerified = true;
            if (request.entityType === 'ex' && referenceImage) {
                try {
                    const verification = await identityVerificationService.verify(
                        base64,
                        referenceImage,
                        request.preferredCoach,
                        assetKey
                    );
                    identityVerified = verification.matches;
                    if (!verification.matches) {
                        logger.warn(`[UserGen] Identity verification failed for ${assetKey}, but continuing for user experience`);
                    }
                } catch (verifyError: any) {
                    logger.warn(`[UserGen] Identity verification error (continuing): ${verifyError.message}`);
                }
            }

            // Store asset
            const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            await UnifiedAssetService.storeAsset(assetKey, buffer, 'image', 'active', {
                prompt,
                persona: request.preferredCoach,
                source: 'user_triggered',
                identityVerified,
                generatedFor: request.userId
            });

            // Update cached_asset_meta with movement_id for future lookups
            const slug = entityKey.split(':')[1];
            await pool.query(
                `INSERT INTO cached_asset_meta (key, movement_id, persona, source)
                 VALUES ($1, $2, $3, 'user_triggered')
                 ON CONFLICT (key) DO UPDATE SET movement_id = $2, persona = $3`,
                [assetKey, `movement_${slug}`, request.preferredCoach]
            );

            return { success: true, imageUrl: base64 };

        } catch (error: any) {
            logger.error(`[UserGen] Primary image generation failed: ${error.message}`);
            return { success: false, imageUrl: null, error: error.message };
        }
    }

    // ------------------------------------------------------------------------
    // Background Pipeline
    // ------------------------------------------------------------------------

    /**
     * Queue the full pipeline to run in background
     */
    private async queueBackgroundPipeline(
        request: UserGenerationRequest,
        priority: 'HIGH' | 'MEDIUM' | 'LOW'
    ): Promise<string | null> {
        try {
            // Create a job to run the full pipeline
            const result = await pool.query(
                `INSERT INTO generation_jobs (
                    user_id, type, status, payload, priority, created_at
                ) VALUES ($1, 'UNIFIED_PIPELINE', 'PENDING', $2, $3, now())
                RETURNING id`,
                [
                    request.userId,
                    JSON.stringify({
                        entityType: request.entityType,
                        entityId: AssetPromptService.normalizeToId(request.entityName),
                        entityName: request.entityName,
                        priority,
                        triggeredBy: 'user',
                        userId: request.userId,
                        options: {
                            // Skip the coach we just generated
                            // Actually, let pipeline handle it - it will skip existing assets
                        }
                    }),
                    priority === 'HIGH' ? 3 : priority === 'MEDIUM' ? 2 : 1
                ]
            );

            const jobId = result.rows[0].id;
            logger.info(`[UserGen] Queued background pipeline job ${jobId} for ${request.entityName}`);
            return jobId;

        } catch (error: any) {
            logger.error(`[UserGen] Failed to queue background pipeline: ${error.message}`);
            return null;
        }
    }

    // ------------------------------------------------------------------------
    // Utility Methods
    // ------------------------------------------------------------------------

    /**
     * Convert asset to data URL
     */
    private assetToDataUrl(asset: { buffer?: Buffer | null; value?: string | null }): string | null {
        if (asset.buffer && asset.buffer.length > 0) {
            return `data:image/png;base64,${asset.buffer.toString('base64')}`;
        }
        if (asset.value) {
            if (asset.value.startsWith('data:')) {
                return asset.value;
            }
            // Check if it's valid base64
            if (asset.value.length > 100) {
                return `data:image/png;base64,${asset.value}`;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------------
    // Batch User Generation
    // ------------------------------------------------------------------------

    /**
     * Pre-generate assets for multiple exercises/meals (for onboarding, plan creation, etc.)
     */
    async pregenerateForPlan(
        userId: string,
        items: Array<{ entityType: EntityType; entityName: string }>,
        preferredCoach: 'atlas' | 'nova'
    ): Promise<{ queued: number; alreadyExists: number }> {
        let queued = 0;
        let alreadyExists = 0;

        for (const item of items) {
            const slug = AssetPromptService.normalizeToId(item.entityName);
            const assetKey = `${item.entityType}:${slug}:${preferredCoach}:main:0`;

            // Check if exists
            const existing = await AssetRepository.findByKey(assetKey);
            if (existing && existing.status === 'active') {
                alreadyExists++;
                continue;
            }

            // Queue for generation
            await pool.query(
                `INSERT INTO generation_jobs (
                    user_id, type, status, payload, priority, created_at
                ) VALUES ($1, 'UNIFIED_PIPELINE', 'PENDING', $2, 1, now())
                ON CONFLICT DO NOTHING`,
                [
                    userId,
                    JSON.stringify({
                        entityType: item.entityType,
                        entityId: slug,
                        entityName: item.entityName,
                        priority: 'LOW',
                        triggeredBy: 'user',
                        userId
                    })
                ]
            );
            queued++;
        }

        logger.info(`[UserGen] Pregenerate: ${queued} queued, ${alreadyExists} already exist`);
        return { queued, alreadyExists };
    }
}

// Export singleton
export const userTriggeredGenerationService = UserTriggeredGenerationService.getInstance();
