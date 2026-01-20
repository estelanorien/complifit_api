
import { UnifiedAssetService, AssetKeyComponents } from './UnifiedAssetService.js';
import { AiService } from './aiService.js';
import { AssetPromptService } from './assetPromptService.js';
import fs from 'fs';
import path from 'path';

// Load Face Anchors
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Jump up from src/application/services to src/assets
const NOVA_REF_PATH = path.resolve(__dirname, '../../assets/coach_nova_ref.png');
const ATLAS_REF_PATH = path.resolve(__dirname, '../../assets/coach_atlas_ref.png');

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
    static async generateAssetForKey(key: string, force = false): Promise<string | null> {
        const components = UnifiedAssetService.parseKey(key);
        if (!components) {
            console.error(`[Orchestrator] Invalid key format: ${key}`);
            return null;
        }

        const { type, id, persona, subtype, index } = components;

        // 1. Atomic Check
        const existing = await UnifiedAssetService.getAsset(key);
        if (existing) {
            if (existing.status === 'active' && !force) return 'EXISTS';
            if (existing.status === 'generating') {
                // If stale > 10 mins, reset. Else skip.
                const updated = (existing.meta as any)?.updated_at || new Date();
                const diff = (new Date().getTime() - new Date(updated).getTime()) / 1000 / 60;
                if (diff < 10) return 'GENERATING';
            }
        }

        // Lock
        await UnifiedAssetService.storeAsset(key, Buffer.from(''), 'image', 'generating', { start_time: new Date() });

        try {
            console.log(`[Orchestrator] Generating ${key}...`);

            // 2. Resolve Context/Prompt
            let instruction = "";
            let context = "";

            if (type === 'ex') {
                // Fetch Meta Asset
                // Key formula: ex:slug:none:meta:0
                const metaKey = UnifiedAssetService.generateKey({ type, id, persona: 'none', subtype: 'meta', index: 0 });
                const metaAsset = await UnifiedAssetService.getAsset(metaKey);

                let instructions: any = {};
                if (metaAsset && metaAsset.buffer && metaAsset.buffer.length > 0) {
                    try { instructions = JSON.parse(metaAsset.buffer.toString()); } catch { }
                }

                // Auto-Generate Meta if missing
                if (!instructions.instructions || !Array.isArray(instructions.instructions)) {
                    console.log(`[Orchestrator] Missing instructions for ${id}, generating meta...`);
                    const newInstr = await AssetPromptService.generateInstructions(id.replace(/_/g, ' '), type === 'ex' ? 'exercise' : 'meal');
                    if (newInstr) {
                        await UnifiedAssetService.storeAsset(metaKey, Buffer.from(JSON.stringify(newInstr)), 'json', 'active');
                        instructions = newInstr;

                        // SYNC TO ENTITY TABLE (Critical for App UI)
                        // The app reads instructions/tips from the entity table, not cached_assets.
                        try {
                            const { pool } = await import('../../infra/db/pool.js');
                            if (type === 'ex') {
                                await pool.query(
                                    `UPDATE training_exercises SET 
                                        metadata = jsonb_set(COALESCE(metadata, '{}'), '{generated_instructions}', $1)
                                     WHERE id = $2`,
                                    [JSON.stringify(newInstr), id]
                                );
                            } else {
                                // Meals
                                await pool.query(
                                    `UPDATE meals SET 
                                        instructions = $1, 
                                        nutrition_tips = $2,
                                        metadata = $3
                                     WHERE id = $4`,
                                    [
                                        JSON.stringify(newInstr.instructions),
                                        JSON.stringify({ science: newInstr.nutrition_science, tips: newInstr.prep_tips, allergens: newInstr.allergens }),
                                        JSON.stringify(newInstr),
                                        id
                                    ]
                                );
                            }
                            console.log(`[Orchestrator] Synced metadata to entity table for ${id}`);
                        } catch (e: any) {
                            console.error(`[Orchestrator] Entity sync failed: ${e.message}`);
                        }
                    }
                }

                // Get Step Text
                if (subtype === 'main') {
                    instruction = instructions.description || `${id.replace(/_/g, ' ')} main hero shot.`;
                } else if (subtype === 'step') {
                    const stepData = instructions.instructions?.[index - 1];
                    instruction = stepData?.detailed || stepData?.instruction || `Step ${index}`;
                }
            } else if (type === 'meal') {
                // Meal generation logic
                const metaKey = UnifiedAssetService.generateKey({ type, id, persona: 'none', subtype: 'meta', index: 0 });
                const metaAsset = await UnifiedAssetService.getAsset(metaKey);

                let instructions: any = {};
                if (metaAsset && metaAsset.buffer && metaAsset.buffer.length > 0) {
                    try { instructions = JSON.parse(metaAsset.buffer.toString()); } catch { }
                }

                // Auto-generate if missing
                if (!instructions.instructions || !Array.isArray(instructions.instructions)) {
                    console.log(`[Orchestrator] Missing meal instructions for ${id}, generating meta...`);
                    const newInstr = await AssetPromptService.generateInstructions(id.replace(/_/g, ' '), 'meal');
                    if (newInstr) {
                        await UnifiedAssetService.storeAsset(metaKey, Buffer.from(JSON.stringify(newInstr)), 'json', 'active');
                        instructions = newInstr;

                        // Sync to meals table
                        try {
                            const { pool } = await import('../../infra/db/pool.js');
                            await pool.query(
                                `UPDATE meals SET 
                                    instructions = $1, 
                                    nutrition_tips = $2,
                                    metadata = $3
                                 WHERE id = $4`,
                                [
                                    JSON.stringify(newInstr.instructions),
                                    JSON.stringify({ science: newInstr.nutrition_science, tips: newInstr.prep_tips, allergens: newInstr.allergens }),
                                    JSON.stringify(newInstr),
                                    id
                                ]
                            );
                            console.log(`[Orchestrator] Synced meal metadata to entity table for ${id}`);
                        } catch (e: any) {
                            console.error(`[Orchestrator] Meal entity sync failed: ${e.message}`);
                        }
                    }
                }

                // Get meal step text
                if (subtype === 'main') {
                    instruction = instructions.description || `Delicious ${id.replace(/_/g, ' ')}`;
                } else if (subtype === 'step') {
                    const stepData = instructions.instructions?.[index - 1];
                    instruction = stepData?.detailed || stepData?.instruction || `Preparation step ${index}`;
                }
            }


            // 3. Construct Prompt with Identity
            let prompt = "";
            let refImage: string | undefined = undefined;

            if (persona === 'atlas') {
                prompt += `Subject: Coach Atlas. Light-skinned Caucasian athletic male with a short dark buzz cut haircut, slight facial stubble, fit muscular build. Wearing a dark grey performance t-shirt and black athletic shorts. Professional gym lighting. `;
                if (fs.existsSync(ATLAS_REF_PATH)) {
                    refImage = fs.readFileSync(ATLAS_REF_PATH, { encoding: 'base64' });
                }
            } else if (persona === 'nova') {
                prompt += `Subject: Coach Nova. Platinum blonde Caucasian female athlete, high ponytail, fit athletic build. Wearing an emerald green sports bra and black athletic leggings. Professional gym lighting. `;
                if (fs.existsSync(NOVA_REF_PATH)) {
                    refImage = fs.readFileSync(NOVA_REF_PATH, { encoding: 'base64' });
                }
            } else {
                prompt += `Subject: Professional Athlete. `;
            }

            // Equipment Enrichment (Bulletproof)
            if (type === 'ex') {
                try {
                    const exRes = await import('../../infra/db/pool.js').then(m => m.pool.query(
                        `SELECT equipment FROM training_exercises WHERE id = $1`,
                        [id]
                    ));
                    const eq = exRes.rows[0]?.equipment;
                    if (Array.isArray(eq) && eq.length > 0) {
                        const maxEq = eq.slice(0, 3).join(', '); // Limit to top 3
                        prompt += `EQUIPMENT: ${maxEq}. `;
                    }
                } catch (err) {
                    console.warn(`[Orchestrator] Failed to fetch equipment for ${id}`);
                }
            }

            prompt += `ACTION: ${instruction}. `;
            prompt += `High quality, 8k, cinematic lighting. CRITICAL: NO TEXT.`;

            // 4. Generate
            const result = await AssetOrchestrator.ai.generateImage({
                prompt,
                referenceImage: refImage,
                model: 'models/gemini-3-pro-image-preview'
            });

            // 5. Store
            const buffer = Buffer.from(result.base64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
            await UnifiedAssetService.storeAsset(key, buffer, 'image', 'active', { prompt });

            console.log(`[Orchestrator] Success: ${key}`);
            return 'SUCCESS';

        } catch (e: any) {
            console.error(`[Orchestrator] Failed ${key}:`, e.message);
            await UnifiedAssetService.storeAsset(key, Buffer.from(''), 'image', 'failed', { error: e.message });
            return 'FAILED';
        }
    }
}
