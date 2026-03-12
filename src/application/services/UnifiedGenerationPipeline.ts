/**
 * UnifiedGenerationPipeline - Single entry point for complete asset generation
 *
 * Orchestrates the complete pipeline:
 * 1. Meta generation (instructions JSON)
 * 2. Image generation (Atlas + Nova for exercises, mannequin for meals)
 * 3. Video generation (queued)
 * 4. Translation generation (queued)
 *
 * Features:
 * - Identity verification for coach images
 * - Automatic retry with exponential backoff
 * - Pipeline status tracking
 * - Dead-letter queue for failed tasks
 */

import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { UnifiedAssetService, EntityType, PersonaType } from './UnifiedAssetService.js';
import { AssetPromptService } from './assetPromptService.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { AiService } from './aiService.js';
import { retryManager, withRetry } from './RetryManager.js';
import { identityVerificationService } from './IdentityVerificationService.js';

// ============================================================================
// Types
// ============================================================================

export interface PipelineRequest {
    entityType: EntityType;
    entityId: string;           // Slug format: "bench_press"
    entityName: string;         // Human readable: "Bench Press"
    stepCount?: number;         // Override step count (default from meta)
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    triggeredBy: 'user' | 'admin' | 'system' | 'batch';
    userId?: string;
    options?: {
        skipMeta?: boolean;
        skipImages?: boolean;
        skipVideos?: boolean;
        skipTranslations?: boolean;
        onlyPersona?: PersonaType;   // Generate only for specific persona
        verifyIdentity?: boolean;     // Default true for exercises
        maxRetries?: number;
    };
}

export interface PipelineResult {
    success: boolean;
    entityKey: string;
    pipelineId: string;
    stages: {
        meta: StageResult;
        images: {
            atlas: ImageStageResult;
            nova: ImageStageResult;
            mannequin: ImageStageResult;
        };
        videos: StageResult & { queued: number };
        translations: StageResult & { queued: number };
    };
    totalGenerated: number;
    totalFailed: number;
    errors: string[];
    duration: number;
}

interface StageResult {
    status: 'success' | 'failed' | 'skipped' | 'partial';
    error?: string;
}

interface ImageStageResult extends StageResult {
    mainGenerated: boolean;
    stepsGenerated: number;
    stepsFailed: number;
    identityVerified: boolean;
}

// ============================================================================
// Pipeline Status Management
// ============================================================================

async function createPipelineStatus(
    entityKey: string,
    entityType: EntityType,
    entityName: string,
    triggeredBy: string,
    userId?: string
): Promise<string> {
    const result = await pool.query(
        `INSERT INTO pipeline_status (
            entity_key, entity_type, entity_name, triggered_by, triggered_by_user_id, started_at
        ) VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (entity_key) DO UPDATE SET
            started_at = now(),
            meta_status = 'pending',
            images_atlas_status = 'pending',
            images_nova_status = 'pending',
            images_mannequin_status = 'pending',
            video_status = 'pending',
            translation_status = 'pending',
            completed_at = NULL,
            last_error = NULL,
            failed_stage = NULL,
            updated_at = now()
        RETURNING id`,
        [entityKey, entityType, entityName, triggeredBy, userId]
    );
    return result.rows[0].id;
}

async function updatePipelineStage(
    entityKey: string,
    stage: string,
    status: string,
    error?: string,
    counts?: { atlas?: number; nova?: number; mannequin?: number; translations?: number }
): Promise<void> {
    const updates: string[] = [`${stage}_status = $2`, `updated_at = now()`];
    const params: any[] = [entityKey, status];
    let paramIndex = 3;

    if (error) {
        updates.push(`last_error = $${paramIndex}`);
        params.push(error);
        paramIndex++;
        updates.push(`failed_stage = '${stage}'`);
    }

    if (counts?.atlas !== undefined) {
        updates.push(`images_atlas_count = $${paramIndex}`);
        params.push(counts.atlas);
        paramIndex++;
    }
    if (counts?.nova !== undefined) {
        updates.push(`images_nova_count = $${paramIndex}`);
        params.push(counts.nova);
        paramIndex++;
    }
    if (counts?.mannequin !== undefined) {
        updates.push(`images_mannequin_count = $${paramIndex}`);
        params.push(counts.mannequin);
        paramIndex++;
    }
    if (counts?.translations !== undefined) {
        updates.push(`translations_queued = $${paramIndex}`);
        params.push(counts.translations);
        paramIndex++;
    }

    await pool.query(
        `UPDATE pipeline_status SET ${updates.join(', ')} WHERE entity_key = $1`,
        params
    );
}

async function completePipeline(entityKey: string): Promise<void> {
    await pool.query(
        `UPDATE pipeline_status SET completed_at = now(), updated_at = now() WHERE entity_key = $1`,
        [entityKey]
    );
}

// ============================================================================
// UnifiedGenerationPipeline Class
// ============================================================================

export class UnifiedGenerationPipeline {
    private static instance: UnifiedGenerationPipeline;
    private aiService: AiService;

    private constructor() {
        this.aiService = new AiService();
    }

    static getInstance(): UnifiedGenerationPipeline {
        if (!UnifiedGenerationPipeline.instance) {
            UnifiedGenerationPipeline.instance = new UnifiedGenerationPipeline();
        }
        return UnifiedGenerationPipeline.instance;
    }

    // ------------------------------------------------------------------------
    // Main Pipeline Execution
    // ------------------------------------------------------------------------

    /**
     * Execute the complete generation pipeline for an entity
     */
    async execute(request: PipelineRequest): Promise<PipelineResult> {
        const startTime = Date.now();
        const slug = AssetPromptService.normalizeToId(request.entityName);
        const entityKey = `${request.entityType}:${slug}`;
        const errors: string[] = [];

        logger.info(`[Pipeline] Starting pipeline for ${entityKey} (triggered by ${request.triggeredBy})`);

        // Initialize result
        const result: PipelineResult = {
            success: false,
            entityKey,
            pipelineId: '',
            stages: {
                meta: { status: 'skipped' },
                images: {
                    atlas: { status: 'skipped', mainGenerated: false, stepsGenerated: 0, stepsFailed: 0, identityVerified: false },
                    nova: { status: 'skipped', mainGenerated: false, stepsGenerated: 0, stepsFailed: 0, identityVerified: false },
                    mannequin: { status: 'skipped', mainGenerated: false, stepsGenerated: 0, stepsFailed: 0, identityVerified: false }
                },
                videos: { status: 'skipped', queued: 0 },
                translations: { status: 'skipped', queued: 0 }
            },
            totalGenerated: 0,
            totalFailed: 0,
            errors: [],
            duration: 0
        };

        try {
            // Create pipeline status record
            result.pipelineId = await createPipelineStatus(
                entityKey,
                request.entityType,
                request.entityName,
                request.triggeredBy,
                request.userId
            );

            // Stage 1: Meta Generation
            if (!request.options?.skipMeta) {
                const metaResult = await this.executeMeta(request, entityKey);
                result.stages.meta = metaResult;
                if (metaResult.status === 'failed') {
                    errors.push(`Meta: ${metaResult.error}`);
                } else {
                    result.totalGenerated++;
                }
            }

            // Determine step count from meta or default
            const stepCount = await this.getStepCount(request, entityKey);

            // Stage 2: Image Generation
            if (!request.options?.skipImages) {
                const imageResult = await this.executeImages(request, entityKey, stepCount);
                result.stages.images = imageResult.images;
                result.totalGenerated += imageResult.generated;
                result.totalFailed += imageResult.failed;
                errors.push(...imageResult.errors);
            }

            // Stage 3: Video Generation (enqueue)
            if (!request.options?.skipVideos) {
                const videoResult = await this.enqueueVideos(request, entityKey);
                result.stages.videos = videoResult;
                if (videoResult.status === 'failed') {
                    errors.push(`Videos: ${videoResult.error}`);
                }
            }

            // Stage 4: Translation Generation (enqueue)
            if (!request.options?.skipTranslations) {
                const translationResult = await this.enqueueTranslations(request, entityKey);
                result.stages.translations = translationResult;
                if (translationResult.status === 'failed') {
                    errors.push(`Translations: ${translationResult.error}`);
                }
            }

            // Complete pipeline
            await completePipeline(entityKey);

            result.success = result.totalFailed === 0 || result.totalGenerated > 0;
            result.errors = errors;
            result.duration = Date.now() - startTime;

            logger.info(`[Pipeline] Completed ${entityKey}: ${result.totalGenerated} generated, ${result.totalFailed} failed, ${result.duration}ms`);

        } catch (error: any) {
            logger.error(`[Pipeline] Pipeline failed for ${entityKey}: ${error.message}`);
            result.errors.push(`Pipeline error: ${error.message}`);
            result.duration = Date.now() - startTime;
        }

        return result;
    }

    // ------------------------------------------------------------------------
    // Stage 1: Meta Generation
    // ------------------------------------------------------------------------

    private async executeMeta(request: PipelineRequest, entityKey: string): Promise<StageResult> {
        const metaKey = `${entityKey}:none:meta:0`;

        try {
            await updatePipelineStage(entityKey, 'meta', 'running');

            // Check if meta already exists
            const existing = await AssetRepository.findByKey(metaKey);
            if (existing && existing.status === 'active' && existing.value) {
                logger.info(`[Pipeline] Meta already exists for ${entityKey}`);
                await updatePipelineStage(entityKey, 'meta', 'completed');
                return { status: 'success' };
            }

            // Generate meta
            const metaJson = await withRetry(
                async () => {
                    const { text } = await this.aiService.generateText({
                        prompt: this.buildMetaPrompt(request.entityType, request.entityName),
                        model: 'models/gemini-2.0-flash'
                    });
                    return text;
                },
                'pipeline',
                `meta:${entityKey}`
            );

            // Parse and validate
            const parsed = JSON.parse(this.cleanJsonResponse(metaJson));

            // Store meta
            await pool.query(
                `INSERT INTO cached_assets (key, value, asset_type, status, updated_at)
                 VALUES ($1, $2, 'json', 'active', now())
                 ON CONFLICT (key) DO UPDATE SET value = $2, status = 'active', updated_at = now()`,
                [metaKey, JSON.stringify(parsed)]
            );

            await updatePipelineStage(entityKey, 'meta', 'completed');
            return { status: 'success' };

        } catch (error: any) {
            logger.error(`[Pipeline] Meta generation failed for ${entityKey}: ${error.message}`);
            await updatePipelineStage(entityKey, 'meta', 'failed', error.message);
            return { status: 'failed', error: error.message };
        }
    }

    // ------------------------------------------------------------------------
    // Stage 2: Image Generation
    // ------------------------------------------------------------------------

    private async executeImages(
        request: PipelineRequest,
        entityKey: string,
        stepCount: number
    ): Promise<{
        images: PipelineResult['stages']['images'];
        generated: number;
        failed: number;
        errors: string[];
    }> {
        const errors: string[] = [];
        let totalGenerated = 0;
        let totalFailed = 0;

        const result: PipelineResult['stages']['images'] = {
            atlas: { status: 'skipped', mainGenerated: false, stepsGenerated: 0, stepsFailed: 0, identityVerified: false },
            nova: { status: 'skipped', mainGenerated: false, stepsGenerated: 0, stepsFailed: 0, identityVerified: false },
            mannequin: { status: 'skipped', mainGenerated: false, stepsGenerated: 0, stepsFailed: 0, identityVerified: false }
        };

        const personas = this.getPersonasForType(request.entityType, request.options?.onlyPersona);
        const verifyIdentity = request.options?.verifyIdentity ?? (request.entityType === 'ex');

        for (const persona of personas) {
            const personaKey = persona as keyof typeof result;
            await updatePipelineStage(entityKey, `images_${persona}`, 'running');

            try {
                const personaResult = await this.executePersonaImages(
                    request,
                    entityKey,
                    persona,
                    stepCount,
                    verifyIdentity
                );

                result[personaKey] = personaResult;
                totalGenerated += (personaResult.mainGenerated ? 1 : 0) + personaResult.stepsGenerated;
                totalFailed += personaResult.stepsFailed + (personaResult.mainGenerated ? 0 : 1);

                if (personaResult.status === 'failed') {
                    errors.push(`${persona}: ${personaResult.error}`);
                }

                await updatePipelineStage(entityKey, `images_${persona}`, personaResult.status, personaResult.error, {
                    [persona]: (personaResult.mainGenerated ? 1 : 0) + personaResult.stepsGenerated
                });

            } catch (error: any) {
                result[personaKey] = {
                    status: 'failed',
                    mainGenerated: false,
                    stepsGenerated: 0,
                    stepsFailed: stepCount + 1,
                    identityVerified: false,
                    error: error.message
                };
                totalFailed += stepCount + 1;
                errors.push(`${persona}: ${error.message}`);
                await updatePipelineStage(entityKey, `images_${persona}`, 'failed', error.message);
            }
        }

        return { images: result, generated: totalGenerated, failed: totalFailed, errors };
    }

    private async executePersonaImages(
        request: PipelineRequest,
        entityKey: string,
        persona: PersonaType,
        stepCount: number,
        verifyIdentity: boolean
    ): Promise<ImageStageResult> {
        const result: ImageStageResult = {
            status: 'success',
            mainGenerated: false,
            stepsGenerated: 0,
            stepsFailed: 0,
            identityVerified: false
        };

        const slug = entityKey.split(':')[1];
        const maxRetries = request.options?.maxRetries ?? 3;

        // Get reference image for identity types
        let referenceImage: string | null = null;
        if (persona === 'atlas' || persona === 'nova') {
            referenceImage = await this.getCoachReference(persona);
            if (!referenceImage && verifyIdentity) {
                throw new Error(`Reference image not found for ${persona}`);
            }
        }

        // Generate main image
        const mainKey = `${request.entityType}:${slug}:${persona}:main:0`;
        try {
            const mainResult = await this.generateImageWithVerification(
                request,
                mainKey,
                persona,
                `main image for ${request.entityName}`,
                referenceImage,
                verifyIdentity,
                maxRetries
            );
            result.mainGenerated = mainResult.success;
            result.identityVerified = mainResult.verified;
        } catch (error: any) {
            logger.error(`[Pipeline] Main image failed for ${mainKey}: ${error.message}`);
            result.stepsFailed++;
        }

        // Generate step images
        const meta = await this.getMetaInstructions(entityKey);
        const steps = meta?.instructions || [];
        const actualStepCount = Math.min(steps.length || stepCount, 10);

        for (let i = 1; i <= actualStepCount; i++) {
            const stepKey = `${request.entityType}:${slug}:${persona}:step:${i}`;
            const stepLabel = steps[i - 1] || `Step ${i}`;

            try {
                const stepResult = await this.generateImageWithVerification(
                    request,
                    stepKey,
                    persona,
                    stepLabel,
                    referenceImage,
                    verifyIdentity && (persona === 'atlas' || persona === 'nova'),
                    maxRetries
                );
                if (stepResult.success) {
                    result.stepsGenerated++;
                } else {
                    result.stepsFailed++;
                }
            } catch (error: any) {
                logger.error(`[Pipeline] Step ${i} failed for ${stepKey}: ${error.message}`);
                result.stepsFailed++;
            }
        }

        // Determine overall status
        if (result.mainGenerated && result.stepsFailed === 0) {
            result.status = 'success';
        } else if (!result.mainGenerated && result.stepsGenerated === 0) {
            result.status = 'failed';
        } else {
            result.status = 'partial';
        }

        return result;
    }

    private async generateImageWithVerification(
        request: PipelineRequest,
        assetKey: string,
        persona: PersonaType,
        label: string,
        referenceImage: string | null,
        verify: boolean,
        maxRetries: number
    ): Promise<{ success: boolean; verified: boolean }> {
        let attempts = 0;
        let lastError: Error | null = null;

        while (attempts < maxRetries) {
            attempts++;

            try {
                // Build prompt
                const { prompt, referenceImage: refImg, referenceType } = await AssetPromptService.constructPrompt({
                    key: assetKey,
                    groupName: request.entityName,
                    groupType: request.entityType === 'ex' ? 'exercise' : 'meal',
                    subtype: assetKey.includes(':main:') ? 'main' : 'step',
                    label,
                    type: 'image'
                });

                // Generate image
                const { base64 } = await this.aiService.generateImage({
                    prompt,
                    referenceImage: refImg || referenceImage || undefined,
                    referenceType: referenceType as 'identity' | 'environment'
                });

                if (!base64) {
                    throw new Error('No image data returned');
                }

                // Verify identity if needed
                let verified = true;
                if (verify && (persona === 'atlas' || persona === 'nova') && referenceImage) {
                    const verification = await identityVerificationService.verify(
                        base64,
                        referenceImage,
                        persona,
                        assetKey
                    );

                    verified = verification.matches;

                    if (!verification.matches && verification.shouldRetry && attempts < maxRetries) {
                        logger.warn(`[Pipeline] Identity verification failed for ${assetKey}, retrying (${attempts}/${maxRetries})`);
                        continue; // Retry
                    }
                }

                // Store asset
                const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
                await UnifiedAssetService.storeAsset(assetKey, buffer, 'image', 'active', {
                    prompt,
                    persona,
                    source: 'pipeline',
                    identityVerified: verified
                });

                return { success: true, verified };

            } catch (error: any) {
                lastError = error;
                const isRetryable = retryManager.isRetryableError(error, ['429', '503', 'overloaded', 'quota']);
                if (!isRetryable || attempts >= maxRetries) {
                    break;
                }
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
            }
        }

        throw lastError || new Error('Image generation failed');
    }

    // ------------------------------------------------------------------------
    // Stage 3 & 4: Video and Translation Enqueueing
    // ------------------------------------------------------------------------

    private async enqueueVideos(request: PipelineRequest, entityKey: string): Promise<StageResult & { queued: number }> {
        try {
            await updatePipelineStage(entityKey, 'video', 'running');

            // Queue video jobs for each persona
            const personas = this.getPersonasForType(request.entityType, request.options?.onlyPersona);
            let queued = 0;

            for (const persona of personas) {
                const metaKey = `${entityKey}:none:meta:0`;
                await pool.query(
                    `INSERT INTO video_jobs (asset_key, persona, status, with_voiceover, languages)
                     VALUES ($1, $2, 'pending', true, ARRAY['en'])
                     ON CONFLICT DO NOTHING`,
                    [metaKey, persona]
                );
                queued++;
            }

            await updatePipelineStage(entityKey, 'video', 'completed');
            return { status: 'success', queued };

        } catch (error: any) {
            await updatePipelineStage(entityKey, 'video', 'failed', error.message);
            return { status: 'failed', queued: 0, error: error.message };
        }
    }

    private async enqueueTranslations(request: PipelineRequest, entityKey: string): Promise<StageResult & { queued: number }> {
        try {
            await updatePipelineStage(entityKey, 'translation', 'running');

            const metaKey = `${entityKey}:none:meta:0`;
            const targetLanguages = ['es', 'fr', 'de', 'it', 'pt', 'tr', 'ar', 'ja', 'ko', 'zh'];

            await pool.query(
                `INSERT INTO translation_jobs (asset_key, target_languages, status)
                 VALUES ($1, $2, 'pending')
                 ON CONFLICT DO NOTHING`,
                [metaKey, targetLanguages]
            );

            await updatePipelineStage(entityKey, 'translation', 'completed', undefined, { translations: targetLanguages.length });
            return { status: 'success', queued: targetLanguages.length };

        } catch (error: any) {
            await updatePipelineStage(entityKey, 'translation', 'failed', error.message);
            return { status: 'failed', queued: 0, error: error.message };
        }
    }

    // ------------------------------------------------------------------------
    // Helper Methods
    // ------------------------------------------------------------------------

    private getPersonasForType(entityType: EntityType, onlyPersona?: PersonaType): PersonaType[] {
        if (onlyPersona) return [onlyPersona];
        return entityType === 'ex' ? ['atlas', 'nova'] : ['mannequin'];
    }

    private async getStepCount(request: PipelineRequest, entityKey: string): Promise<number> {
        if (request.stepCount) return request.stepCount;

        const meta = await this.getMetaInstructions(entityKey);
        return meta?.instructions?.length || 6;
    }

    private async getMetaInstructions(entityKey: string): Promise<{ instructions?: string[] } | null> {
        const metaKey = `${entityKey}:none:meta:0`;
        const asset = await AssetRepository.findByKey(metaKey);
        if (!asset?.value) return null;

        try {
            return JSON.parse(asset.value);
        } catch {
            return null;
        }
    }

    private async getCoachReference(persona: 'atlas' | 'nova'): Promise<string | null> {
        const refKey = persona === 'atlas' ? 'system_coach_atlas_ref' : 'system_coach_nova_ref';
        const asset = await AssetRepository.findByKey(refKey);
        if (!asset) return null;

        if (asset.buffer && asset.buffer.length > 0) {
            return `data:image/png;base64,${asset.buffer.toString('base64')}`;
        }
        if (asset.value && asset.value.length > 0) {
            return asset.value.startsWith('data:') ? asset.value : `data:image/png;base64,${asset.value}`;
        }
        return null;
    }

    private buildMetaPrompt(entityType: EntityType, entityName: string): string {
        if (entityType === 'ex') {
            return `Generate exercise instructions for "${entityName}".
Return JSON with this structure:
{
    "instructions": ["step 1 description", "step 2 description", ...],
    "safetyWarnings": ["warning 1", "warning 2"],
    "proTips": ["tip 1", "tip 2"],
    "commonMistakes": ["mistake 1", "mistake 2"]
}
Provide 6-10 clear, concise instruction steps. Return ONLY valid JSON.`;
        } else {
            return `Generate cooking instructions for "${entityName}".
Return JSON with this structure:
{
    "instructions": ["step 1 description", "step 2 description", ...],
    "cookingTips": ["tip 1", "tip 2"],
    "nutritionNotes": ["note 1", "note 2"]
}
Provide 6-10 clear, concise cooking steps. Return ONLY valid JSON.`;
        }
    }

    private cleanJsonResponse(text: string): string {
        let cleaned = text.trim();
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        return cleaned;
    }
}

// Export singleton
export const unifiedGenerationPipeline = UnifiedGenerationPipeline.getInstance();
