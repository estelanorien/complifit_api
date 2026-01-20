import { AssetGenerationFacade } from '../src/application/services/AssetGenerationFacade.js';
import { pool } from '../src/infra/db/pool.js';

async function main() {
    console.log('=== UNIFIED ASSET GENERATION SYSTEM TEST ===\n');

    try {
        // Test 1: Get a test exercise
        console.log('1. Fetching test exercise...');
        const exRes = await pool.query(`
            SELECT id, name FROM training_exercises 
            WHERE name IS NOT NULL 
            LIMIT 1
        `);

        if (exRes.rows.length === 0) {
            console.log('❌ No exercises found in database');
            process.exit(1);
        }

        const testExercise = exRes.rows[0];
        console.log(`✓ Found exercise: ${testExercise.name} (${testExercise.id})\n`);

        // Test 2: Check asset status
        console.log('2. Checking asset status...');
        const status = await AssetGenerationFacade.getAssetStatus('ex', testExercise.id);
        console.log(`   Total: ${status.total}`);
        console.log(`   Complete: ${status.complete}`);
        console.log(`   Failed: ${status.failed}`);
        console.log(`   Empty: ${status.empty}\n`);

        // Test 3: Generate assets for single exercise
        console.log('3. Generating assets for single exercise...');
        const result = await AssetGenerationFacade.generateForEntity('ex', testExercise.id);

        console.log(`   Success: ${result.success}`);
        console.log(`   Step Count: ${result.stepCount}`);
        console.log(`   Assets Generated: ${result.assetsGenerated}`);
        console.log(`   Assets Failed: ${result.assetsFailed}`);
        if (result.errors.length > 0) {
            console.log(`   Errors: ${result.errors.join(', ')}`);
        }
        console.log('');

        // Test 4: Verify assets were created
        console.log('4. Verifying assets in database...');
        const finalStatus = await AssetGenerationFacade.getAssetStatus('ex', testExercise.id);
        console.log(`   Complete: ${finalStatus.complete}/${finalStatus.total}`);
        console.log(`   Failed: ${finalStatus.failed}`);
        console.log(`   Empty: ${finalStatus.empty}\n`);

        if (finalStatus.complete > 0) {
            console.log('✅ TEST PASSED: Assets successfully generated!');
        } else {
            console.log('⚠️  WARNING: No assets were marked as complete');
        }

    } catch (e: any) {
        console.error('❌ TEST FAILED:', e.message);
        console.error(e.stack);
        process.exit(1);
    }

    process.exit(0);
}

main();
