
import { env } from '../config/env.js';
import { pool } from '../infra/db/pool.js';
import { AiService } from '../application/services/aiService.js';

export interface AssetGenOptions {
    mode: 'image' | 'video' | 'json';
    prompt: string;
    key?: string; // Cache key
    status?: 'active' | 'draft' | 'auto' | 'generating' | 'failed';
    movementId?: string;
    imageInput?: string; // Base64
    imageInputType?: 'identity' | 'environment';
    model?: string;
    persona?: 'atlas' | 'nova' | 'mannequin';
    stepIndex?: number;
    textContext?: string;
    textContextSimple?: string;
    originalName?: string;
}

export const generateAsset = async (options: AssetGenOptions): Promise<string | null> => {
    const {
        mode, prompt, key, status = 'active', movementId, imageInput, imageInputType = 'identity', model,
        persona, stepIndex, textContext, textContextSimple, originalName
    } = options;

    console.log(`[GenAsset] ========== ENTRY ==========`);
    console.log(`[GenAsset] Key: ${key}`);
    console.log(`[GenAsset] Mode: ${mode}`);
    console.log(`[GenAsset] Status: ${status}`);
    console.log(`[GenAsset] MovementId: ${movementId}`);
    console.log(`[GenAsset] HasImageInput: ${!!imageInput}`);
    console.log(`[GenAsset] Prompt length: ${prompt?.length || 0}`);

    if (!env.geminiApiKey) throw new Error("GEMINI_API_KEY missing");

    const ai = new AiService();
    let value: string | null = null;
    let attempts = 0;
    const maxAttempts = 3;
    let currentImageInput = imageInput;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            console.log(`[Gen] Attempt ${attempts}/${maxAttempts} for ${key || 'anonymous'} (Mode: ${mode}, HasRef: ${!!currentImageInput})`);

            if (mode === 'image') {
                const result = await ai.generateImage({
                    prompt,
                    referenceImage: currentImageInput,
                    referenceType: imageInputType,
                    model
                });
                value = result.base64;
            } else if (mode === 'json') {
                const result = await ai.generateText({ prompt, model });
                value = result.text;
            } else if (mode === 'video') {
                value = await ai.generateVideo({ prompt });
            }

            if (value) break; // Success!

        } catch (error: any) {
            console.error(`[Gen] Attempt ${attempts} failed:`, error.message);

            // CRITICAL: Do NOT retry without reference image - this causes bald coaches
            // If safety block occurs WITH reference image, log it clearly and throw
            if (error.message.includes('SAFETY_BLOCK') && currentImageInput) {
                console.error(`[Gen] ❌ SAFETY BLOCK on ${key || 'anonymous'} - The reference image was rejected. NOT retrying without it (would cause identity loss).`);
                throw new Error(`SAFETY_BLOCK: Reference image rejected for ${key}. Please regenerate the coach reference image.`);
            }

            if (attempts >= maxAttempts) {
                // Persistent failure
                if (key) {
                    await pool.query(
                        `UPDATE cached_assets SET status = 'failed' WHERE key = $1`,
                        [key]
                    );
                }
                throw error;
            }

            // Wait slightly before retry for non-safety errors (possible rate limits)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
    }

    // Cache Result
    if (value && key) {
        console.log(`[GenAsset] Saving to cached_assets: ${key}`);
        await pool.query(
            `INSERT INTO cached_assets(key, value, asset_type, status)
           VALUES($1, $2, $3, $4)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, asset_type=EXCLUDED.asset_type, status=EXCLUDED.status`,
            [key, value, mode === 'json' ? 'json' : mode, status === 'generating' ? 'active' : status]
        );

        console.log(`[GenAsset] Saving to cached_asset_meta: ${key}`);
        await pool.query(
            `INSERT INTO cached_asset_meta(
                key, prompt, mode, source, created_by, 
                movement_id, persona, step_index, 
                text_context, text_context_simple, original_name
            )
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (key) DO UPDATE SET 
                prompt=EXCLUDED.prompt, 
                mode=EXCLUDED.mode, 
                source=EXCLUDED.source, 
                created_by=EXCLUDED.created_by,
                movement_id=EXCLUDED.movement_id,
                persona=EXCLUDED.persona,
                step_index=EXCLUDED.step_index,
                text_context=EXCLUDED.text_context,
                text_context_simple=EXCLUDED.text_context_simple,
                original_name=EXCLUDED.original_name`,
            [
                key, prompt, mode, 'hardened_gen_v4', 'system',
                movementId || null, persona || null, stepIndex || null,
                textContext || null, textContextSimple || null, originalName || null
            ]
        );
        console.log(`[GenAsset] ✅ SAVED to DB: ${key}`);
    } else {
        console.log(`[GenAsset] ⚠️ No value or key - NOT saving. Key: ${key}, HasValue: ${!!value}`);
    }

    console.log(`[GenAsset] ========== EXIT ==========`);
    return value;
};
