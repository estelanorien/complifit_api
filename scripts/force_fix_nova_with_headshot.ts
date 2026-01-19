
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const SAFE_HEADSHOT_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9/coach_nova_headshot_safe_1768855506416.png';
const MOVEMENT_ID = "25m_sprint_25m_slow";

async function cacheAsset(client: any, key: string, value: string, type: 'image', status: string) {
    console.log(`[DB] Writing ${key} (${status})...`);
    await client.query(
        `INSERT INTO cached_assets(key, value, asset_type, status)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status`,
        [key, value, type, status]
    );
}

async function generateWithHeadshot(apiKey: string, prompt: string, headshotBase64: string): Promise<string | null> {
    const model = 'models/gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    const body = {
        contents: [{
            parts: [
                { text: prompt },
                {
                    inlineData: {
                        mimeType: "image/png",
                        data: headshotBase64
                    }
                }
            ]
        }],
        generationConfig: {
            responseModalities: ["IMAGE"]
        }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            console.error(`  ❌ API HTTP Error: ${res.status} ${res.statusText}`);
            const txt = await res.text();
            console.error(txt);
            return null;
        }

        const data: any = await res.json();

        if (data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
            return data.candidates[0].content.parts[0].inlineData.data;
        } else {
            console.error("  ⚠️ Blocked/Empty Response (Safety or Quality)");
            if (data.promptFeedback) console.log("  PromptFeedback:", JSON.stringify(data.promptFeedback));
            if (data.candidates?.[0]?.finishReason) console.log("  FinishReason:", data.candidates[0].finishReason);
            return null;
        }
    } catch (e: any) {
        console.error("  ❌ Exception:", e.message);
        return null;
    }
}

async function run() {
    console.log("--- FORCE FIX: NOVA WITH HEADSHOT ---");
    const client = await pool.connect();

    try {
        if (!fs.existsSync(SAFE_HEADSHOT_PATH)) throw new Error("Headshot file missing");
        const headshotBuffer = fs.readFileSync(SAFE_HEADSHOT_PATH);
        const headshotBase64 = headshotBuffer.toString('base64');
        const apiKey = process.env.GEMINI_API_KEY || "";

        const assets = [
            {
                key: `ex_${MOVEMENT_ID}_nova_main`,
                prompt: "Cinematic fitness photography. High contrast, 8k. Subject: Coach Nova (blonde female athlete) performing 25m Sprint. Professional, non-revealing, serious training context. Use reference face."
            }
        ];

        for (let i = 1; i <= 6; i++) {
            assets.push({
                key: `ex_${MOVEMENT_ID}_nova_step_${i}`,
                prompt: `Cinematic fitness photography. Coach Nova (blonde female) performing step ${i} of 25m Sprint 25m Slow. Focus on correct form. Use reference face.`
            });
        }

        for (const asset of assets) {
            console.log(`\nProcessing ${asset.key}...`);
            await cacheAsset(client, asset.key, '', 'image', 'generating');

            // Retry Loop
            let success = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`  Attempt ${attempt}/3...`);
                const base64 = await generateWithHeadshot(apiKey, asset.prompt, headshotBase64);

                if (base64) {
                    await cacheAsset(client, asset.key, base64, 'image', 'active');
                    console.log("  ✅ SUCCESS");
                    success = true;
                    break;
                } else {
                    console.log("  ❌ FAILED. Retrying...");
                    // Wait 2s before retry
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            if (!success) {
                console.error(`  💀 PERMANENT FAILURE for ${asset.key}`);
                await cacheAsset(client, asset.key, '', 'image', 'failed');
            }
        }

    } catch (e) {
        console.error("FATAL:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
