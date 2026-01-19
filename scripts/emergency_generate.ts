
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

const TARGET_GROUP = "25m Sprint 25m Slow";
const MOVEMENT_ID = "25m_sprint_25m_slow"; // Normalized

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
    console.log("--- EMERGENCY ASSET GENERATION ---");
    const ai = new AiService();
    const client = await pool.connect();

    try {
        // 1. Get Reference Images
        console.log("Fetching Coach Refs...");
        const resAtlas = await client.query("SELECT value FROM cached_assets WHERE key='system_coach_atlas_ref'");
        const resNova = await client.query("SELECT value FROM cached_assets WHERE key='system_coach_nova_ref'");
        const atlasRef = resAtlas.rows[0]?.value;
        const novaRef = resNova.rows[0]?.value;

        if (!atlasRef || !novaRef) throw new Error("Missing Coach Refs in DB");

        // 2. Define Missing Assets
        const assets = [
            {
                key: `ex_${MOVEMENT_ID}_atlas_main`,
                prompt: "Cinematic fitness photography. High contrast, dramatic lighting, 8k. Subject: 25m Sprint 25m Slow performed by Coach Atlas (28yo male, short dark blonde hair, athletic, grey t-shirt). Perfect execution.",
                ref: atlasRef
            },
            {
                key: `ex_${MOVEMENT_ID}_nova_main`,
                prompt: "Cinematic fitness photography. High contrast, dramatic lighting, 8k. Subject: 25m Sprint 25m Slow performed by Coach Nova (28yo female, blonde ponytail, athletic, black tank top). Perfect execution.",
                ref: novaRef
            }
        ];

        // Add Nova Steps (1-6) - Usually 6 stages
        for (let i = 1; i <= 6; i++) {
            assets.push({
                key: `ex_${MOVEMENT_ID}_nova_step_${i}`,
                prompt: `Cinematic fitness photography. Coach Nova performing step ${i} of 25m Sprint 25m Slow. Keep face and head intact and change body positions for training.`,
                ref: novaRef
            });
        }

        // 3. Generate Loop
        for (const asset of assets) {
            console.log(`Generating ${asset.key}...`);
            await cacheAsset(client, asset.key, '', 'image', 'generating');

            try {
                const res = await ai.generateImage({
                    prompt: asset.prompt,
                    referenceImage: asset.ref
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
