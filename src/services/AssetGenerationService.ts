
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { pool } from '../infra/db/pool.js';
import { z } from 'zod';

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

    let value: string | null = null;

    if (mode === 'image') {
        const model = 'gemini-2.5-flash-image';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        // Helper to prepare parts
        const parts: any[] = [];
        if (imageInput) {
            const base64Data = imageInput.replace(/^data:image\/\w+;base64,/, "");
            parts.push({ inlineData: { mimeType: "image/png", data: base64Data } });
        }
        parts.push({ text: prompt });

        const res = await fetch(genEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': env.geminiApiKey
            },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    responseModalities: ['IMAGE']
                }
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Gemini Image Gen Failed: ${res.status} ${err}`);
        }

        const data: any = await res.json();
        const resParts = data?.candidates?.[0]?.content?.parts || [];
        const inline = resParts.find((p: any) => p.inlineData?.data);
        if (inline?.inlineData?.data) {
            value = `data:image/png;base64,${inline.inlineData.data}`;
        }
    } else if (mode === 'json') {
        const model = 'gemini-3-flash-preview';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const res = await fetch(genEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': env.geminiApiKey
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!res.ok) throw new Error(`Gemini JSON Gen Failed: ${res.status}`);
        const data: any = await res.json();
        value = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (mode === 'video') {
        // Veo Logic (using preview endpoint)
        const model = 'models/veo-001-preview';
        const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

        // Helper to prepare parts
        const parts: any[] = [];
        if (imageInput) {
            const base64Data = imageInput.replace(/^data:image\/\w+;base64,/, "");
            parts.push({ inlineData: { mimeType: "image/png", data: base64Data } });
        }
        parts.push({ text: prompt });

        try {
            const res = await fetch(genEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': env.geminiApiKey
                },
                body: JSON.stringify({
                    contents: [{ parts }]
                })
            });

            if (!res.ok) throw new Error(`Veo unavailable: ${res.status}`);
            const data: any = await res.json();
            value = data?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri;
        } catch (e) {
            logger.warn("Veo generation failed, falling back to mock", { error: String(e) });
            value = null;
        }
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
            [key, prompt, mode, 'batch_service', 'system']
        );
    }

    return value;
};
