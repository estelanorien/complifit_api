
import { UnifiedAssetService } from './UnifiedAssetService.js';
import { AiService } from './aiService.js';
import { AssetPromptService } from './assetPromptService.js';
import { UnifiedKey } from '../../domain/UnifiedKey.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { MovementRepository } from '../../infra/db/repositories/MovementRepository.js';
import path from 'path';

// Load Face Anchors
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Jump up from src/application/services to src/assets

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
        // #region agent log
        const fs = await import('fs/promises');
        const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
        const logEntry = JSON.stringify({location:'AssetOrchestrator.ts:27',message:'generateAssetForKey entry',data:{keyStr,force},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'}) + '\n';
        fs.appendFile(logPath, logEntry).catch(()=>{});
        // #endregion

        let uKey: UnifiedKey;
        try {
            uKey = UnifiedKey.parse(keyStr);
        } catch (e: any) {
            console.error(`[Orchestrator] ${e.message}`);
            // #region agent log
            const logEntry2 = JSON.stringify({location:'AssetOrchestrator.ts:32',message:'Key parse error',data:{keyStr,error:e.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'}) + '\n';
            fs.appendFile(logPath, logEntry2).catch(()=>{});
            // #endregion
            return null;
        }

        const { type, id, persona, subtype, index } = uKey;

        // #region agent log
        const logEntry3 = JSON.stringify({location:'AssetOrchestrator.ts:36',message:'Key parsed',data:{keyStr,type,id,persona,subtype,index,keyContainsAtlas:keyStr.toLowerCase().includes('atlas'),keyContainsNova:keyStr.toLowerCase().includes('nova')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.1'}) + '\n';
        fs.appendFile(logPath, logEntry3).catch(()=>{});
        // #endregion

        // 1. Atomic Check via Repository
        const existing = await AssetRepository.findByKey(uKey);
        if (existing) {
            if (existing.status === 'active' && !force) {
                // BACKFILL: Even if asset exists, update text_context if missing
                const needsTextBackfill = !existing.metadata?.text_context && !existing.metadata?.text_context_simple;
                if (needsTextBackfill && (type === 'ex' || type === 'meal')) {
                    console.log(`[Orchestrator] Backfilling text for existing asset ${keyStr}`);
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
                            console.log(`[Orchestrator] Meta empty/broken for ${id}, regenerating...`);
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
                                console.log(`[Orchestrator] Meta regenerated for ${id} with ${instructions.instructions.length} steps`);
                            } else {
                                console.warn(`[Orchestrator] Meta regeneration returned empty for ${id}, keeping existing`);
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
                                console.log(`[Orchestrator] Using fallback text for ${keyStr}`);
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
                            console.log(`[Orchestrator] Text backfilled for ${keyStr}: "${textSimple}" / "${textDetailed.substring(0,50)}..."`);
                        }
                    } catch (e: any) {
                        console.warn(`[Orchestrator] Text backfill failed for ${keyStr}: ${e.message}`);
                    }
                }
                // #region agent log
                const logEntry4 = JSON.stringify({location:'AssetOrchestrator.ts:40',message:'Asset exists',data:{keyStr,status:existing.status,needsTextBackfill},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'}) + '\n';
                fs.appendFile(logPath, logEntry4).catch(()=>{});
                // #endregion
                return 'EXISTS';
            }
            if (existing.status === 'generating') {
                const diff = (new Date().getTime() - new Date(existing.updated_at).getTime()) / 1000 / 60;
                if (diff < 10) {
                    // #region agent log
                    const logEntry5 = JSON.stringify({location:'AssetOrchestrator.ts:43',message:'Asset generating, skipping',data:{keyStr,status:existing.status,minutesSinceStart:diff},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.2'}) + '\n';
                    fs.appendFile(logPath, logEntry5).catch(()=>{});
                    // #endregion
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
            console.log(`[Orchestrator] Generating ${uKey.toString()}...`);
            // #region agent log - Nova hero tracking
            if (persona === 'nova' && subtype === 'main') {
                const fs = await import('fs/promises');
                const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
                const logEntry = JSON.stringify({location:'AssetOrchestrator.ts:NOVA_HERO_START',message:'Nova hero generation started',data:{keyStr,type,id,persona,subtype,index},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H_NOVA_HERO'}) + '\n';
                fs.appendFile(logPath, logEntry).catch(()=>{});
            }
            // #endregion

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
                    console.log(`[Orchestrator] Missing/empty instructions for ${id}, generating meta...`);
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
                        console.log(`[Orchestrator] Meta generated for ${id} with ${instructions.instructions.length} steps`);

                        // SYNC TO ENTITY TABLE (Critical for App UI) via MovementRepository
                        try {
                            await MovementRepository.updateMetadata(type, id, newInstr);
                            console.log(`[Orchestrator] Synced metadata to entity table for ${id}`);
                        } catch (e: any) {
                            console.error(`[Orchestrator] Entity sync failed: ${e.message}`);
                        }
                    } else {
                        console.warn(`[Orchestrator] Meta generation returned empty for ${id}`);
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


            // 3. Construct Prompt with Unified Logic
            const { prompt, referenceImage, referenceType } = await AssetPromptService.constructPrompt({
                key: uKey.toString(),
                groupName: id.replace(/_/g, ' '),
                groupType: type === 'ex' ? 'exercise' : 'meal',
                subtype: subtype as 'main' | 'step',
                label: instruction,
                type: 'image',
                context: instruction
            });

            // #region agent log
            const fs = await import('fs/promises');
            const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
            const logEntry = JSON.stringify({location:'AssetOrchestrator.ts:113',message:'Prompt constructed',data:{keyStr,promptLength:prompt.length,hasReferenceImage:!!referenceImage,referenceType,referenceImageLength:referenceImage?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1.2'}) + '\n';
            fs.appendFile(logPath, logEntry).catch(()=>{});
            // #endregion

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
                } catch (err) {
                    console.warn(`[Orchestrator] Failed to fetch equipment for ${id}`);
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
                    console.log(`[Orchestrator] Generation attempt ${attempt}/${maxRetries} for ${uKey.toString()}`);
                    
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
                    
                    console.warn(`[Orchestrator] Attempt ${attempt} failed for ${uKey.toString()}: ${e.message}`);
                    
                    if (isRetryable && attempt < maxRetries) {
                        const delay = retryDelay * attempt; // Exponential backoff
                        console.log(`[Orchestrator] Retrying in ${delay}ms...`);
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

            console.log(`[Orchestrator] Success: ${uKey.toString()}`);
            // #region agent log - Nova hero success
            if (persona === 'nova' && subtype === 'main') {
                const fs = await import('fs/promises');
                const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
                const logEntry = JSON.stringify({location:'AssetOrchestrator.ts:NOVA_HERO_SUCCESS',message:'Nova hero generation succeeded',data:{keyStr,type,id,persona,subtype,index,resultLength:result.base64?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H_NOVA_HERO'}) + '\n';
                fs.appendFile(logPath, logEntry).catch(()=>{});
            }
            // #endregion
            return 'SUCCESS';

        } catch (e: any) {
            console.error(`[Orchestrator] Failed ${uKey.toString()}:`, e.message);
            
            // Log more details for debugging
            const fs = await import('fs/promises');
            const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
            const isNovaHero = persona === 'nova' && subtype === 'main';
            const errorLog = JSON.stringify({
                location: isNovaHero ? 'AssetOrchestrator.ts:NOVA_HERO_FAILED' : 'AssetOrchestrator.ts:CATCH',
                message: isNovaHero ? 'Nova hero generation failed' : 'Generation failed',
                data: { 
                    keyStr, 
                    type, id, persona, subtype, index,
                    error: e.message, 
                    stack: e.stack?.substring(0, 300),
                    isSafetyBlock: e.message?.includes('SAFETY'),
                    isRateLimit: e.message?.includes('429') || e.message?.includes('quota'),
                    isModelError: e.message?.includes('model') || e.message?.includes('404')
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                runId: 'run1',
                hypothesisId: isNovaHero ? 'H_NOVA_HERO' : 'H6.1'
            }) + '\n';
            fs.appendFile(logPath, errorLog).catch(() => {});
            
            await AssetRepository.save(uKey, {
                status: 'failed',
                type: 'image',
                metadata: { error: e.message }
            });
            return 'FAILED';
        }
    }
}
