
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
                // #region agent log
                const logEntry4 = JSON.stringify({location:'AssetOrchestrator.ts:40',message:'Asset exists, skipping',data:{keyStr,status:existing.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5.1'}) + '\n';
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

            // 2. Resolve Context/Prompt
            let instruction = "";
            let context = "";

            if (type === 'ex' || type === 'meal') {
                // Fetch Meta Asset
                const metaKey = uKey.toMetaKey();
                const metaAsset = await AssetRepository.findByKey(metaKey);

                let instructions: any = {};
                if (metaAsset && metaAsset.buffer && metaAsset.buffer.length > 0) {
                    try { instructions = JSON.parse(metaAsset.buffer.toString()); } catch { }
                }

                // Auto-Generate Meta if missing
                if (!instructions.instructions || !Array.isArray(instructions.instructions)) {
                    console.log(`[Orchestrator] Missing instructions for ${id}, generating meta...`);
                    const newInstr = await AssetPromptService.generateInstructions(id.replace(/_/g, ' '), type === 'ex' ? 'exercise' : 'meal');
                    if (newInstr) {
                        await AssetRepository.save(metaKey, {
                            buffer: Buffer.from(JSON.stringify(newInstr)),
                            status: 'active',
                            type: 'json'
                        });
                        instructions = newInstr;

                        // SYNC TO ENTITY TABLE (Critical for App UI) via MovementRepository
                        try {
                            await MovementRepository.updateMetadata(type, id, newInstr);
                            console.log(`[Orchestrator] Synced metadata to entity table for ${id}`);
                        } catch (e: any) {
                            console.error(`[Orchestrator] Entity sync failed: ${e.message}`);
                        }
                    }
                }

                // Get Step/Main Text
                if (subtype === 'main') {
                    instruction = instructions.description || `${id.replace(/_/g, ' ')} main hero shot.`;
                } else if (subtype === 'step') {
                    const stepData = instructions.instructions?.[index - 1];
                    instruction = stepData?.detailed || stepData?.instruction || `Step ${index}`;
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

            // 4. Generate
            const result = await AssetOrchestrator.ai.generateImage({
                prompt: finalPrompt,
                referenceImage: referenceImage,
                referenceType: referenceType,
                model: 'models/gemini-2.0-flash-exp'
            });

            // 5. Store via Repository
            const buffer = Buffer.from(result.base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
            await AssetRepository.save(uKey, {
                buffer,
                status: 'active',
                type: 'image',
                metadata: { prompt: finalPrompt }
            });

            console.log(`[Orchestrator] Success: ${uKey.toString()}`);
            return 'SUCCESS';

        } catch (e: any) {
            console.error(`[Orchestrator] Failed ${uKey.toString()}:`, e.message);
            await AssetRepository.save(uKey, {
                status: 'failed',
                type: 'image',
                metadata: { error: e.message }
            });
            return 'FAILED';
        }
    }
}
