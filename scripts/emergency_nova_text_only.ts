
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
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
    console.log("--- EMERGENCY NOVA (TEXT ONLY) GENERATION ---");
    const ai = new AiService();
    const client = await pool.connect();

    try {
        // Define Nova Assets (Text Only Prompts)
        const assets = [
            {
                key: `ex_${MOVEMENT_ID}_nova_main`,
                prompt: "Cinematic fitness photography. High contrast, 8k. Subject: Coach Nova (28yo female athlete, blonde ponytail, wearing high-neck black athletic shirt) performing 25m Sprint. Professional, non-revealing, serious training context."
            }
        ];

        // Add Nova Steps
        for (let i = 1; i <= 6; i++) {
            assets.push({
                key: `ex_${MOVEMENT_ID}_nova_step_${i}`,
                prompt: `Cinematic fitness photography. Coach Nova (blonde ponytail, modest black athletic wear) performing step ${i} of 25m Sprint 25m Slow. Focus on correct form. Professional training.`
            });
        }

        // Generate Loop (No Reference Image)
        for (const asset of assets) {
            console.log(`Generating ${asset.key} (No Ref)...`);
            await cacheAsset(client, asset.key, '', 'image', 'generating');

            try {
                // Pass NO reference image to avoid safety triggers
                const res = await ai.generateImage({
                    prompt: asset.prompt
                    // referenceImage: undefined 
                });

                if (res.base64) {
                    await cacheAsset(client, asset.key, res.base64, 'image', 'active');
                    console.log("SUCCESS");
                } else {
                    console.error("Null response");
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
