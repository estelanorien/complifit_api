
import { pool } from '../src/infra/db/pool.js';
import { AssetOrchestrator } from '../src/application/services/AssetOrchestrator.js';
import { UnifiedAssetService } from '../src/application/services/UnifiedAssetService.js';
import fs from 'fs';
import path from 'path';

async function main() {
    try {
        console.log("--- FACE CONSISTENCY CHECK ---");

        // 1. Find Arnold Press
        const res = await pool.query(`SELECT id, name FROM training_exercises WHERE name ILIKE '%Arnold Press%' LIMIT 1`);
        if (res.rows.length === 0) throw new Error("Arnold Press not found!");
        const ex = res.rows[0];

        // 2. Define Target Keys (Step 2 for both)
        const atlasKey = UnifiedAssetService.generateKey({ type: 'ex', id: ex.id, persona: 'atlas', subtype: 'step', index: 2 });
        const novaKey = UnifiedAssetService.generateKey({ type: 'ex', id: ex.id, persona: 'nova', subtype: 'step', index: 2 });

        console.log(`Generating Atlas: ${atlasKey}`);
        await AssetOrchestrator.generateAssetForKey(atlasKey, true); // force=true to ensure fresh gen

        console.log(`Generating Nova: ${novaKey}`);
        await AssetOrchestrator.generateAssetForKey(novaKey, true);

        // 3. Export Images
        const brainDir = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9';

        const atlasAsset = await UnifiedAssetService.getAsset(atlasKey);
        if (atlasAsset?.buffer) {
            fs.writeFileSync(path.join(brainDir, 'verify_atlas_face.png'), atlasAsset.buffer);
            console.log("Saved verify_atlas_face.png");
        }

        const novaAsset = await UnifiedAssetService.getAsset(novaKey);
        if (novaAsset?.buffer) {
            fs.writeFileSync(path.join(brainDir, 'verify_nova_face.png'), novaAsset.buffer);
            console.log("Saved verify_nova_face.png");
        }

        console.log("DONE.");

    } catch (e: any) {
        console.error("Verification Script Failed:", e.message);
    }
    process.exit(0);
}
main();
