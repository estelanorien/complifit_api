
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        const exCount = await pool.query('SELECT COUNT(*) FROM training_exercises');
        const mealCount = await pool.query('SELECT COUNT(*) FROM meals');

        // Check equipment - handle if it's stored as array or string or null
        // The previous schema dump showed 'equipment' as ARRAY in training_exercises
        const equipCount = await pool.query(`
            SELECT DISTINCT unnest(equipment) as eq 
            FROM training_exercises 
            WHERE equipment IS NOT NULL
        `);

        console.log('--- STATS ---');
        console.log(`Total Exercises: ${exCount.rows[0].count}`);
        console.log(`Total Meals: ${mealCount.rows[0].count}`);
        console.log(`Distinct Equipment: ${equipCount.rows.map(r => r.eq).join(', ')}`);

    } catch (e: any) {
        console.error("Error gathering stats:", e.message);
    }
    process.exit(0);
}
main();
