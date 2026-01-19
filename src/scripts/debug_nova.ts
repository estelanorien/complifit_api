
import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../infra/db/pool.js';
import { generateAsset } from '../services/AssetGenerationService.js';

async function main() {
    console.log("Starting Debug Script for Nova Image Generation...");

    try {
        // 1. Fetch Reference Images
        console.log("Fetching reference images...");
        const res = await pool.query("SELECT key, value FROM cached_assets WHERE key IN ('system_coach_atlas_ref', 'system_coach_nova_ref')");

        const atlasRef = res.rows.find(r => r.key === 'system_coach_atlas_ref')?.value;
        const novaRef = res.rows.find(r => r.key === 'system_coach_nova_ref')?.value;

        console.log(`Atlas Ref found: ${!!atlasRef} (Length: ${atlasRef?.length})`);
        console.log(`Nova Ref found: ${!!novaRef} (Length: ${novaRef?.length})`);

        if (!atlasRef || !novaRef) {
            console.error("Missing reference images!");
            process.exit(1);
        }

        // 2. Try Atlas (Control)
        console.log("\n--- Testing ATLAS Generation ---");
        try {
            await generateAsset({
                mode: 'image',
                prompt: "Cinematic fitness photography. High contrast, dramatic lighting. SUBJECT: Ankle Alphabet. FEATURING COACH ATLAS.",
                key: 'debug_atlas_test',
                status: 'draft', // Don't overwrite real assets
                imageInput: atlasRef
            });
            console.log("✅ ATLAS Generation SUCCESS");
        } catch (e) {
            console.error("❌ ATLAS Generation FAILED:", e);
        }

        // 3. Try Nova (Test)
        console.log("\n--- Testing NOVA Generation ---");
        try {
            await generateAsset({
                mode: 'image',
                prompt: "Cinematic fitness photography. High contrast, dramatic lighting. SUBJECT: Ankle Alphabet. FEATURING COACH NOVA.",
                key: 'debug_nova_test',
                status: 'draft',
                imageInput: novaRef
            });
            console.log("✅ NOVA Generation SUCCESS");
        } catch (e) {
            console.error("❌ NOVA Generation FAILED:", e);
            if (e instanceof Error) {
                console.error("Error Name:", e.name);
                console.error("Error Message:", e.message);
                console.error("Error Stack:", e.stack);
            }
        }

    } catch (err) {
        console.error("Unexpected script error:", err);
    } finally {
        await pool.end();
    }
}

main();
