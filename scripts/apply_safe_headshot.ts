
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AiService } from '../src/application/services/aiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Path to the approved Safe Headshot
const SAFE_HEADSHOT_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9/coach_nova_headshot_safe_1768855506416.png';
const MOVEMENT_ID = "25m_sprint_25m_slow";

async function cacheAsset(client: any, key: string, value: string, type: 'image', status: string) {
    console.log(`[DB] Writing ${key}...`);
    await client.query(
        `INSERT INTO cached_assets(key, value, asset_type, status)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, status=EXCLUDED.status`,
        [key, value, type, status]
    );
}

async function run() {
    console.log("--- APPLYING SAFE HEADSHOT FOR NOVA & REGENERATING ---");
    const ai = new AiService();
    const client = await pool.connect();

    try {
        // 1. Read & Encode New Reference
        if (!fs.existsSync(SAFE_HEADSHOT_PATH)) {
            throw new Error(`File not found: ${SAFE_HEADSHOT_PATH}`);
        }
        const buffer = fs.readFileSync(SAFE_HEADSHOT_PATH);
        const base64Ref = `data:image/png;base64,${buffer.toString('base64')}`;
        console.log("Safe Headshot Loaded.");

        // 2. Update DB with New Reference
        console.log("Updating system_coach_nova_ref...");
        await cacheAsset(client, 'system_coach_nova_ref', base64Ref, 'image', 'active');
        console.log("✅ Coach Nova Reference Updated (Headshot).");

        // 3. Define Nova Assets to Regenerate (Using Reference Image)
        const novaAssets = [
            {
                key: `ex_${MOVEMENT_ID}_nova_main`,
                prompt: "Cinematic fitness photography. High contrast, dramatic lighting, 8k. Subject: 25m Sprint 25m Slow performed by Coach Nova (28yo female, blonde ponytail, athletic, high-neck black t-shirt). Perfect execution."
            }
        ];

        // Add Nova Steps
        for (let i = 1; i <= 6; i++) {
            novaAssets.push({
                key: `ex_${MOVEMENT_ID}_nova_step_${i}`,
                prompt: `Cinematic fitness photography. Coach Nova (in modest athletic wear) performing step ${i} of 25m Sprint 25m Slow. Keep face and head intact from reference.`
            });
        }

        // 4. Regenerate Using New Ref
        for (const asset of novaAssets) {
            console.log(`Regenerating ${asset.key} (With Headshot Ref)...`);
            await cacheAsset(client, asset.key, '', 'image', 'generating');

            try {
                // Pass the SAFE HEADSHOT as reference
                const res = await ai.generateImage({
                    prompt: asset.prompt,
                    referenceImage: base64Ref
                });

                if (res.base64) {
                    await cacheAsset(client, asset.key, res.base64, 'image', 'active');
                    console.log("SUCCESS");
                } else {
                    console.error("Null response (Safety Block?)");
                    await cacheAsset(client, asset.key, '', 'image', 'failed');
                }
            } catch (e: any) {
                console.error("FAILED Gen:", e.message);
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
