import { pool } from '../src/infra/db/pool.js';
import { AssetGenerationFacade } from '../src/application/services/AssetGenerationFacade.js';

interface SeedOptions {
    type: 'ex' | 'meal' | 'both';
    count?: number;
    status: 'empty' | 'failed' | 'all';
}

function parseArgs(): SeedOptions {
    const args = process.argv.slice(2);
    const options: SeedOptions = {
        type: 'both',
        status: 'empty'
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--type' && args[i + 1]) {
            options.type = args[i + 1] as 'ex' | 'meal' | 'both';
            i++;
        } else if (arg === '--count' && args[i + 1]) {
            options.count = parseInt(args[i + 1]);
            i++;
        } else if (arg === '--status' && args[i + 1]) {
            options.status = args[i + 1] as 'empty' | 'failed' | 'all';
            i++;
        }
    }

    return options;
}

async function main() {
    try {
        const options = parseArgs();

        console.log('=== GLOBAL ASSET SEEDER ===');
        console.log(`Type: ${options.type}`);
        console.log(`Status Filter: ${options.status}`);
        console.log(`Count Limit: ${options.count || 'unlimited'}\n`);

        const itemsToGenerate: Array<{ type: 'ex' | 'meal', id: string, name: string }> = [];

        // Fetch exercises
        if (options.type === 'ex' || options.type === 'both') {
            console.log('Fetching exercises...');
            const exercises = await pool.query(`
                SELECT id, name 
                FROM training_exercises 
                WHERE name IS NOT NULL
                ORDER BY created_at DESC
                ${options.count ? `LIMIT ${options.count}` : ''}
            `);

            for (const ex of exercises.rows) {
                const assetStatus = await AssetGenerationFacade.getAssetStatus('ex', ex.id);

                let shouldGenerate = false;
                if (options.status === 'empty' && assetStatus.empty > 0) {
                    shouldGenerate = true;
                } else if (options.status === 'failed' && assetStatus.failed > 0) {
                    shouldGenerate = true;
                } else if (options.status === 'all') {
                    shouldGenerate = true;
                }

                if (shouldGenerate) {
                    itemsToGenerate.push({ type: 'ex', id: ex.id, name: ex.name });
                }

                if (options.count && itemsToGenerate.length >= options.count) {
                    break;
                }
            }

            console.log(`Found ${itemsToGenerate.length} exercises to process\n`);
        }

        // Fetch meals
        if (options.type === 'meal' || options.type === 'both') {
            console.log('Fetching meals...');
            const currentExCount = itemsToGenerate.length;
            const remainingCount = options.count ? options.count - currentExCount : undefined;

            const meals = await pool.query(`
                SELECT id, name 
                FROM meals 
                WHERE name IS NOT NULL
                ORDER BY created_at DESC
                ${remainingCount ? `LIMIT ${remainingCount}` : ''}
            `);

            for (const meal of meals.rows) {
                const assetStatus = await AssetGenerationFacade.getAssetStatus('meal', meal.id);

                let shouldGenerate = false;
                if (options.status === 'empty' && assetStatus.empty > 0) {
                    shouldGenerate = true;
                } else if (options.status === 'failed' && assetStatus.failed > 0) {
                    shouldGenerate = true;
                } else if (options.status === 'all') {
                    shouldGenerate = true;
                }

                if (shouldGenerate) {
                    itemsToGenerate.push({ type: 'meal', id: meal.id, name: meal.name });
                }

                if (options.count && itemsToGenerate.length >= options.count) {
                    break;
                }
            }

            console.log(`Found ${itemsToGenerate.length - currentExCount} meals to process\n`);
        }

        if (itemsToGenerate.length === 0) {
            console.log('No items to generate. Exiting.');
            process.exit(0);
        }

        console.log(`=== STARTING GENERATION FOR ${itemsToGenerate.length} ITEMS ===\n`);

        // Use facade batch generation with progress tracking
        const result = await AssetGenerationFacade.generateBatch(
            itemsToGenerate.map(item => ({ type: item.type, id: item.id })),
            {
                sequential: true,
                delayMs: 2000,
                onProgress: (current, total, currentItem) => {
                    const percentage = Math.round((current / total) * 100);
                    console.log(`[${current}/${total}] (${percentage}%) - ${currentItem}`);
                }
            }
        );

        console.log('\n=== GENERATION COMPLETE ===');
        console.log(`Total Items: ${result.totalItems}`);
        console.log(`Completed: ${result.completed}`);
        console.log(`Failed: ${result.failed}`);
        console.log(`Success Rate: ${Math.round((result.completed / result.totalItems) * 100)}%`);

        // Show detailed results
        console.log('\n=== DETAILED RESULTS ===');
        for (const itemResult of result.results) {
            const item = itemsToGenerate.find(i => i.id === itemResult.entityId);
            const status = itemResult.success ? '✓' : '✗';
            console.log(`${status} ${item?.name || itemResult.entityId}: ${itemResult.assetsGenerated} generated, ${itemResult.assetsFailed} failed`);
            if (itemResult.errors.length > 0) {
                itemResult.errors.forEach(err => console.log(`  - ${err}`));
            }
        }

    } catch (e: any) {
        console.error('Seeder Failed:', e.message);
        console.error(e.stack);
        process.exit(1);
    }

    process.exit(0);
}

main();
