
import { env } from '../config/env.js';
import { pool } from '../infra/db/pool.js';
import { z } from 'zod';
import { AiService } from '../application/services/aiService.js';

export interface AssetGenOptions {
    mode: 'image' | 'video' | 'json';
    prompt: string;
    key?: string; // Cache key
    status?: 'active' | 'draft' | 'auto';
    movementId?: string;
    imageInput?: string; // Base64
}

export const generateAsset = async (options: AssetGenOptions): Promise<string | null> => {
    const { mode, prompt, key, status = 'active', movementId, imageInput } = options;

    if (!env.geminiApiKey) throw new Error("GEMINI_API_KEY missing");

    const ai = new AiService();
    let value: string | null = null;

    if (mode === 'image') {
        // Delegate to AiService (uses gemini-2.5-flash-image w/ prompt cleaning)
        const result = await ai.generateImage({
            prompt,
            referenceImage: imageInput
        });
        value = result.base64;

    } else if (mode === 'json') {
        // Delegate to AiService (uses gemini-2.5-flash)
        const result = await ai.generateText({
            prompt,
            // Explicitly set JSON mime type via generation config if needed, 
            // but AiService default text generation is usually sufficient if prompt asks for JSON.
            // However, let's pass a hint or just rely on the prompt.
            // The original code passed `generationConfig: { responseMimeType: 'application/json' }` implicitly via the schema in `ai.ts`? 
            // No, `AssetGenerationService` old code just sent prompt. 
            // Let's rely on the prompt asking for JSON as before.
        });
        value = result.text;

    } else if (mode === 'video') {
        // Delegate to AiService (uses Veo or fallback)
        value = await ai.generateVideo({ prompt });
    }

    // Cache Result
    if (value && key) {
        await pool.query(
            `INSERT INTO cached_assets(key, value, asset_type, status)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, asset_type=EXCLUDED.asset_type, status=EXCLUDED.status`,
            [key, value, mode === 'json' ? 'json' : mode, status]
        );
        // meta
        await pool.query(
            `INSERT INTO cached_asset_meta(key, prompt, mode, source, created_by)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (key) DO UPDATE SET 
                prompt=EXCLUDED.prompt, 
                mode=EXCLUDED.mode, 
                source=EXCLUDED.source, 
                created_by=EXCLUDED.created_by`,
            [key, prompt, mode, 'batch_service_v2', 'system']
        );
    }

    return value;
};
