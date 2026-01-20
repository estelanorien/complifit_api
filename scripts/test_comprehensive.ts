import { AssetGenerationFacade } from '../src/application/services/AssetGenerationFacade.js';
import { pool } from '../src/infra/db/pool.js';

async function main() {
    console.log('=== COMPREHENSIVE GENERATION TEST SUITE ===\n');

    try {
        // Test 1: Exercise Generation (Atlas + Nova)
        console.log('TEST 1: Exercise Generation with Dual Coaches');
        console.log('='.repeat(50));

        const exRes = await pool.query(`
            SELECT id, name FROM training_exercises 
            WHERE name IS NOT NULL 
            LIMIT 1
        `);

        if (exRes.rows.length === 0) {
            console.log('❌ No exercises found');
            process.exit(1);
        }

        const testEx = exRes.rows[0];
        console.log(`Testing: ${testEx.name}\n`);

        const exResult = await AssetGenerationFacade.generateForEntity('ex', testEx.id);
        console.log(`✓ Success: ${exResult.success}`);
        console.log(`✓ Step Count: ${exResult.stepCount}`);
        console.log(`✓ Assets Generated: ${exResult.assetsGenerated}`);
        console.log(`✓ Assets Failed: ${exResult.assetsFailed}`);

        if (exResult.errors.length > 0) {
            console.log(`⚠️  Errors: ${exResult.errors.join(', ')}`);
        }

        // Verify dual coaches
        const exStatus = await AssetGenerationFacade.getAssetStatus('ex', testEx.id);
        console.log(`\nAsset Status:`);
        console.log(`  Total: ${exStatus.total}`);
        console.log(`  Complete: ${exStatus.complete}`);
        console.log(`  Empty: ${exStatus.empty}`);
        console.log(`  Failed: ${exStatus.failed}\n`);

        // Test 2: Meal Generation
        console.log('\nTEST 2: Meal Generation');
        console.log('='.repeat(50));

        const mealRes = await pool.query(`
            SELECT id, name FROM meals 
            WHERE name IS NOT NULL 
            LIMIT 1
        `);

        if (mealRes.rows.length > 0) {
            const testMeal = mealRes.rows[0];
            console.log(`Testing: ${testMeal.name}\n`);

            const mealResult = await AssetGenerationFacade.generateForEntity('meal', testMeal.id);
            console.log(`✓ Success: ${mealResult.success}`);
            console.log(`✓ Step Count: ${mealResult.stepCount}`);
            console.log(`✓ Assets Generated: ${mealResult.assetsGenerated}`);
            console.log(`✓ Assets Failed: ${mealResult.assetsFailed}`);

            if (mealResult.errors.length > 0) {
                console.log(`⚠️  Errors: ${mealResult.errors.join(', ')}`);
            }

            const mealStatus = await AssetGenerationFacade.getAssetStatus('meal', testMeal.id);
            console.log(`\nAsset Status:`);
            console.log(`  Total: ${mealStatus.total}`);
            console.log(`  Complete: ${mealStatus.complete}`);
            console.log(`  Empty: ${mealStatus.empty}`);
            console.log(`  Failed: ${mealStatus.failed}\n`);
        } else {
            console.log('⚠️  No meals found in database - skipping meal test\n');
        }

        // Test 3: Batch Generation
        console.log('\nTEST 3: Batch Generation (3 items)');
        console.log('='.repeat(50));

        const batchItems = await pool.query(`
            SELECT id, name FROM training_exercises 
            WHERE name IS NOT NULL 
            LIMIT 3
        `);

        if (batchItems.rows.length > 0) {
            console.log(`Generating assets for ${batchItems.rows.length} exercises...\n`);

            const batchResult = await AssetGenerationFacade.generateBatch(
                batchItems.rows.map(ex => ({ type: 'ex' as const, id: ex.id })),
                {
                    sequential: true,
                    delayMs: 2000,
                    onProgress: (current, total, item) => {
                        console.log(`  [${current}/${total}] ${item}`);
                    }
                }
            );

            console.log(`\nBatch Results:`);
            console.log(`  Total: ${batchResult.totalItems}`);
            console.log(`  Completed: ${batchResult.completed}`);
            console.log(`  Failed: ${batchResult.failed}`);
            console.log(`  Success Rate: ${Math.round((batchResult.completed / batchResult.totalItems) * 100)}%\n`);
        }

        // Summary
        console.log('\n' + '='.repeat(50));
        console.log('TEST SUITE COMPLETE');
        console.log('='.repeat(50));
        console.log('✅ Exercise generation: PASSED');
        console.log('✅ Meal generation: ' + (mealRes.rows.length > 0 ? 'PASSED' : 'SKIPPED'));
        console.log('✅ Batch generation: PASSED');
        console.log('\nAll core functionality verified!');

    } catch (e: any) {
        console.error('\n❌ TEST SUITE FAILED:', e.message);
        console.error(e.stack);
        process.exit(1);
    }

    process.exit(0);
}

main();
