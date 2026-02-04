
import { UnifiedAssetService } from './UnifiedAssetService.js';
import { AiService } from './aiService.js';
import { AssetPromptService } from './assetPromptService.js';
import { UnifiedKey } from '../../domain/UnifiedKey.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { MovementRepository } from '../../infra/db/repositories/MovementRepository.js';

export class AssetOrchestrator {
    private static ai = new AiService();

    /**
     * The master method to generate an asset.
     * 1. PARSE Key
     * 2. CHECK Status (Atomic Lock)
     * 3. INJECT Identity
     * 4. GENERATE
     * 5. STORE
     */
    static async generateAssetForKey(keyStr: string, force = false): Promise<string | null> {
        let uKey: UnifiedKey;
        try {
            uKey = UnifiedKey.parse(keyStr);
        } catch {
            return null;
        }

        const { type, id, persona, subtype, index } = uKey;

        // 1. Atomic Check via Repository
        const existing = await AssetRepository.findByKey(uKey);
        if (existing) {
            if (existing.status === 'active' && !force) {
                // BACKFILL: Even if asset exists, update text_context if missing
                const needsTextBackfill = !existing.metadata?.text_context && !existing.metadata?.text_context_simple;
                if (needsTextBackfill && (type === 'ex' || type === 'meal')) {
                    try {
                        // Fetch instructions from meta
                        const metaKey = uKey.toMetaKey();
                        const metaAsset = await AssetRepository.findByKey(metaKey);
                        let instructions: any = {};
                        // Check both buffer (blob storage) AND value (cached_assets.value string)
                        const metaContent = metaAsset?.buffer?.toString() || metaAsset?.value;
                        if (metaContent && metaContent.length > 0) {
                            try { instructions = JSON.parse(metaContent); } catch {}
                        }
                        
                        // CRITICAL: If meta is empty/broken, REGENERATE it
                        // FIX: Also check for EMPTY arrays (length === 0)
                        if (!instructions.instructions || !Array.isArray(instructions.instructions) || instructions.instructions.length === 0) {
                            const newInstr = await AssetPromptService.generateInstructions(id.replace(/_/g, ' '), type === 'ex' ? 'exercise' : 'meal');
                            // SAFEGUARD: Only save if we got actual instructions (not empty array)
                            if (newInstr && Array.isArray(newInstr.instructions) && newInstr.instructions.length > 0) {
                                await AssetRepository.save(metaKey, {
                                    buffer: Buffer.from(JSON.stringify(newInstr)),
                                    status: 'active',
                                    type: 'json',
                                    metadata: { movementId: id }
                                });
                                instructions = newInstr;
                            }
                        }
                        
                        let textDetailed = '';
                        let textSimple = '';
                        if (subtype === 'main') {
                            textDetailed = instructions.description || '';
                            textSimple = id.replace(/_/g, ' ');
                        } else if (subtype === 'step') {
                            const stepData = instructions.instructions?.[index - 1];
                            textDetailed = stepData?.detailed || stepData?.instruction || '';
                            textSimple = stepData?.simple || '';
                            
                            // FALLBACK: If meta has no step data, generate simple default
                            // This ensures text always gets saved even if meta regeneration fails
                            if (!textDetailed && !textSimple) {
                                const exerciseName = id.replace(/_/g, ' ');
                                textSimple = `Step ${index}`;
                                textDetailed = `${exerciseName} - execution step ${index}`;
                            }
                        }
                        
                        if (textDetailed || textSimple) {
                            await AssetRepository.save(uKey, {
                                status: 'active',
                                type: existing.asset_type || 'image',
                                metadata: {
                                    ...existing.metadata,
                                    movementId: id,
                                    persona: persona,
                                    stepIndex: subtype === 'step' ? index : null,
                                    textContext: textDetailed,
                                    textContextSimple: textSimple
                                }
                            });
                        }
                    } catch {
                        // Text backfill failed - non-critical
                    }
                }
                return 'EXISTS';
            }
            if (existing.status === 'generating') {
                const diff = (new Date().getTime() - new Date(existing.updated_at).getTime()) / 1000 / 60;
                if (diff < 10) {
                    return 'GENERATING';
                }
            }
        }

        // Lock
        await AssetRepository.save(uKey, {
            status: 'generating',
            type: subtype === 'meta' ? 'json' : 'image',
            metadata: { start_time: new Date() }
        });

        try {
            // 2. Resolve Context/Prompt
            let instruction = "";
            let context = "";
            
            // IMPORTANT: Declare text variables at try-block scope so they're accessible when saving
            let textDetailed = '';
            let textSimple = '';

            if (type === 'ex' || type === 'meal') {
                // Fetch Meta Asset
                const metaKey = uKey.toMetaKey();
                const metaAsset = await AssetRepository.findByKey(metaKey);

                let instructions: any = {};
                // Check both buffer (blob storage) AND value (cached_assets.value string)
                const metaContent = metaAsset?.buffer?.toString() || metaAsset?.value;
                if (metaContent && metaContent.length > 0) {
                    try { instructions = JSON.parse(metaContent); } catch { }
                }

                // Auto-Generate Meta if missing (also regenerate if empty array)
                if (!instructions.instructions || !Array.isArray(instructions.instructions) || instructions.instructions.length === 0) {
                    const newInstr = await AssetPromptService.generateInstructions(id.replace(/_/g, ' '), type === 'ex' ? 'exercise' : 'meal');
                    // SAFEGUARD: Only save if we got actual instructions (not empty array)
                    if (newInstr && Array.isArray(newInstr.instructions) && newInstr.instructions.length > 0) {
                        await AssetRepository.save(metaKey, {
                            buffer: Buffer.from(JSON.stringify(newInstr)),
                            status: 'active',
                            type: 'json',
                            metadata: { movementId: id }
                        });
                        instructions = newInstr;

                        // SYNC TO ENTITY TABLE (Critical for App UI) via MovementRepository
                        try {
                            await MovementRepository.updateMetadata(type, id, newInstr);
                        } catch {
                            // Entity sync failed - non-critical
                        }
                    }
                }

                // Get Step/Main Text - capture both detailed and simple for DB storage
                if (subtype === 'main') {
                    instruction = instructions.description || `${id.replace(/_/g, ' ')} main hero shot.`;
                    textDetailed = instructions.description || '';
                    textSimple = id.replace(/_/g, ' ');
                } else if (subtype === 'step') {
                    const stepData = instructions.instructions?.[index - 1];
                    instruction = stepData?.detailed || stepData?.instruction || `Step ${index}`;
                    textDetailed = stepData?.detailed || stepData?.instruction || '';
                    textSimple = stepData?.simple || '';
                    
                    // FALLBACK: If meta has no step data, generate simple default
                    if (!textDetailed && !textSimple) {
                        const exerciseName = id.replace(/_/g, ' ');
                        textSimple = `Step ${index}`;
                        textDetailed = `${exerciseName} - execution step ${index}`;
                    }
                }
            }


            // 3. Construct Prompt with Unified Logic (ALWAYS uses coach ref for Atlas/Nova exercise images)
            const { prompt, referenceImage, referenceType } = await AssetPromptService.constructPrompt({
                key: uKey.toString(),
                groupName: id.replace(/_/g, ' '),
                groupType: type === 'ex' ? 'exercise' : 'meal',
                subtype: subtype as 'main' | 'step',
                label: instruction,
                type: 'image',
                context: instruction
            });
            // CRITICAL: Never generate Atlas/Nova exercise images without reference—prevents wrong person (e.g. bald) in output
            if (type === 'ex' && (persona === 'atlas' || persona === 'nova') && (subtype === 'main' || subtype === 'step') && !referenceImage) {
                throw new Error(`CRITICAL: Coach reference image missing for ${persona}. Upload system_coach_${persona}_ref in Admin (Refs Status) before generating. NEVER generate without reference image.`);
            }
            // Equipment Enrichment via Repository
            let finalPrompt = prompt;
            if (type === 'ex') {
                try {
                    const exercise = await MovementRepository.findExerciseById(id);
                    const eq = exercise?.equipment;
                    if (Array.isArray(eq) && eq.length > 0) {
                        const maxEq = eq.slice(0, 3).join(', ');
                        finalPrompt += ` EQUIPMENT: ${maxEq}.`;
                    }
                } catch {
                    // Failed to fetch equipment - non-critical
                }
            }

            // 4. Generate with retry logic for rate limits and transient errors
            // FIX: Use gemini-2.5-flash-image which supports image generation (not gemini-2.0-flash-exp)
            let result: { base64: string } | null = null;
            let lastError: Error | null = null;
            const maxRetries = 3;
            const retryDelay = 3000; // 3 seconds base delay
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    
                    result = await AssetOrchestrator.ai.generateImage({
                        prompt: finalPrompt,
                        referenceImage: referenceImage,
                        referenceType: referenceType,
                        model: 'models/gemini-2.5-flash-image'
                    });
                    
                    break; // Success, exit retry loop
                    
                } catch (e: any) {
                    lastError = e;
                    const isRetryable = e.message?.includes('429') ||
                                       e.message?.includes('503') ||
                                       e.message?.includes('overloaded') ||
                                       e.message?.includes('quota') ||
                                       e.message?.includes('rate');

                    if (isRetryable && attempt < maxRetries) {
                        const delay = retryDelay * attempt; // Exponential backoff
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                    
                    // Non-retryable error or max retries reached
                    throw e;
                }
            }
            
            if (!result) {
                throw lastError || new Error('Image generation failed after retries');
            }

            // 5. Store via Repository - include text_context for UI display
            const buffer = Buffer.from(result.base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
            await AssetRepository.save(uKey, {
                buffer,
                status: 'active',
                type: 'image',
                metadata: { 
                    prompt: finalPrompt,
                    movementId: id, // Save the slug for searchability (camelCase for AssetRepository)
                    persona: persona,
                    stepIndex: subtype === 'step' ? index : null,
                    textContext: textDetailed, // Detailed narration text
                    textContextSimple: textSimple // Simple cue text
                }
            });

            return 'SUCCESS';

        } catch (e: any) {
            await AssetRepository.save(uKey, {
                status: 'failed',
                type: 'image',
                metadata: { error: e.message }
            });
            return 'FAILED';
        }
    }
}
