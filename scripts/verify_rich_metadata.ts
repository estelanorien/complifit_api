
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        console.log("--- VERIFYING RICH METADATA ---");

        // 1. Check Exercises
        const exRes = await pool.query(`
            SELECT id, name, metadata, instructions 
            FROM training_exercises 
            WHERE metadata->'generated_instructions' IS NOT NULL 
            LIMIT 5
        `);

        console.log(`\nExercises with Generated Meta: ${exRes.rows.length}`);
        for (const row of exRes.rows) {
            const meta = row.metadata.generated_instructions;
            console.log(`[Exercise: ${row.name}]`);
            console.log(` - Safety Warnings: ${meta.safety_warnings?.length || 0}`);
            console.log(` - Pro Tips: ${meta.pro_tips?.length || 0}`);
            if (meta.safety_warnings?.length > 0) {
                console.log(`   * Example Warning: "${meta.safety_warnings[0]}"`);
            }
        }

        // 2. Check Meals
        const mealRes = await pool.query(`
            SELECT id, name, nutrition_tips, instructions 
            FROM meals 
            WHERE nutrition_tips IS NOT NULL 
            LIMIT 5
        `);

        console.log(`\nMeals with Generated Meta: ${mealRes.rows.length}`);
        for (const row of mealRes.rows) {
            const tips = row.nutrition_tips; // JSONB
            console.log(`[Meal: ${row.name}]`);
            console.log(` - Science Length: ${tips.science ? tips.science.length : 0}`);
            console.log(` - Allergens: ${tips.allergens?.join(', ')}`);
            if (tips.science) {
                console.log(`   * Science Snippet: "${tips.science.substring(0, 50)}..."`);
            }
        }

    } catch (e: any) {
        console.error("Verification Failed:", e.message);
    }
    process.exit(0);
}
main();
