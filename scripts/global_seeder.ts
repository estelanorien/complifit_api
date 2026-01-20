
import { pool } from '../src/infra/db/pool.js';
import { AssetOrchestrator } from '../src/application/services/AssetOrchestrator.js';
import { UnifiedAssetService } from '../src/application/services/UnifiedAssetService.js';

async function main() {
    try {
        console.log("--- GLOBAL SEEDER STARTED ---");

        // 1. Fetch Priority Exercises
        // Prioritize fundamental movements by name
        const priorityKeywords = ['Squat', 'Press', 'Deadlift', 'Row', 'Lunge', 'Pushup', 'Pullup', 'Curl'];
        let query = `SELECT id, name FROM training_exercises WHERE name IS NOT NULL`;

        // Simple ordering: Priority keywords first
        // PostgreSQL doesn't have easy regex sorting, so we'll sort in JS.
        const res = await pool.query(query);
        const allExercises = res.rows;

        const priority = [];
        const others = [];

        for (const ex of allExercises) {
            if (priorityKeywords.some(k => ex.name.includes(k))) {
                priority.push(ex);
            } else {
                others.push(ex);
            }
        }

        const queue = [...priority, ...others];
        console.log(`Loaded ${queue.length} exercises. Priority: ${priority.length}`);

        // 2. Processing Loop
        let processed = 0;

        for (const ex of queue) {
            console.log(`[Seeder] Processing Group: ${ex.name}`);

            // Generate Manifest
            const keys = await UnifiedAssetService.getManifest('ex', ex.id, ex.name, 6); // 6 steps default

            for (const key of keys) {
                // Determine if we should skip (e.g. if we only want to seed priorities first)
                // For now, full seed.

                const result = await AssetOrchestrator.generateAssetForKey(key);

                if (result === 'SUCCESS') {
                    processed++;
                    // Rate Limit: 2s
                    await new Promise(r => setTimeout(r, 2000));
                } else if (result === 'EXISTS') {
                    // process.stdout.write('.');
                } else {
                    console.log(`[Seeder] Error/Skip for ${key}`);
                }
            }

            // Check global limit if needed?
            // if (processed > 500) break; 
        }

        console.log("--- GLOBAL SEEDER COMPLETE ---");

    } catch (e: any) {
        console.error("Seeder Failed:", e.message);
    }
    process.exit(0);
}
main();
