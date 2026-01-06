
import { pool } from '../infra/db/pool';

async function run() {
    console.log('Starting schema fix for logs tables...');

    try {
        // 1. Convert food_logs_simple columns
        await pool.query(`ALTER TABLE food_logs_simple ALTER COLUMN id TYPE text;`);
        console.log('Fixed food_logs_simple.id');
        await pool.query(`ALTER TABLE food_logs_simple ALTER COLUMN linked_plan_item_id TYPE text;`);
        console.log('Fixed food_logs_simple.linked_plan_item_id');

        // 2. Convert exercise_logs_simple columns
        await pool.query(`ALTER TABLE exercise_logs_simple ALTER COLUMN id TYPE text;`);
        console.log('Fixed exercise_logs_simple.id');

        // 3. Convert plan_completion_logs columns
        await pool.query(`ALTER TABLE plan_completion_logs ALTER COLUMN id TYPE text;`);
        console.log('Fixed plan_completion_logs.id');

        // 4. Convert extra_exercise_logs columns
        await pool.query(`ALTER TABLE extra_exercise_logs ALTER COLUMN id TYPE text;`);
        console.log('Fixed extra_exercise_logs.id');

        console.log('Schema fix completed successfully.');
    } catch (err) {
        console.error('Schema fix failed:', err);
    } finally {
        process.exit(0);
    }
}

run();
