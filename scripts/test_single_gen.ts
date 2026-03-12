
import { pool } from '../src/infra/db/pool.js';
import { AssetOrchestrator } from '../src/application/services/AssetOrchestrator.js';
import { UnifiedAssetService } from '../src/application/services/UnifiedAssetService.js';
import fs from 'fs';
import path from 'path';

async function main() {
    try {
        console.log("--- TEST GEN: ARNOLD PRESS ---");

        // 1. Find the exercise
        const res = await pool.query(`SELECT id, name FROM training_exercises WHERE name ILIKE '%Arnold Press%' LIMIT 1`);
        if (res.rows.length === 0) throw new Error("Arnold Press not found!");

        const ex = res.rows[0];
        console.log(`Found: ${ex.name} (${ex.id})`);

        // 2. Clear existing assets for this ID (Clean Test)
        // Deterministic keys rely on ID and slug.
        // Let's get the keys first.
        const keys = await UnifiedAssetService.getManifest('ex', ex.id, ex.name, 6);
        console.log(`Generated Manifest with ${keys.length} keys.`);

        console.log("Clearing old assets for test...");
        await pool.query(`DELETE FROM cached_assets WHERE key = ANY($1)`, [keys]);
        await pool.query(`DELETE FROM asset_blob_storage WHERE key = ANY($1)`, [keys]);

        // 3. Generate
        console.log("Starting Generation...");
        for (const key of keys) {
            await AssetOrchestrator.generateAssetForKey(key);
            // Throttle slightly
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log("--- VERIFICATION ---");
        // 4. Dump Metadata
        const exUpdated = await pool.query(`SELECT metadata, instructions FROM training_exercises WHERE id = $1`, [ex.id]);
        const meta = exUpdated.rows[0].metadata?.generated_instructions;
        console.log("Rich Metadata:", JSON.stringify(meta, null, 2));

        // 5. Save an Image for User Review
        // Let's pick Atlas Step 2
        const sampleKey = keys.find(k => k.includes('atlas') && k.includes('step:2'));
        if (sampleKey) {
            const asset = await UnifiedAssetService.getAsset(sampleKey);
            if (asset && asset.buffer) {
                const outPath = path.resolve('C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9/test_arnold_atlas_step2.png');
                fs.writeFileSync(outPath, asset.buffer);
                console.log(`Saved sample image to: ${outPath}`);
            }
        }

    } catch (e: any) {
        console.error("Test Failed:", e.message);
    }
    process.exit(0);
}
main();
