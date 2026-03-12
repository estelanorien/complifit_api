
import { pool } from '../src/infra/db/pool.js';

async function main() {
    try {
        console.log("--- CLEANING UP RECENT ASSETS ---");
        // Delete assets created in last 60 mins
        console.log("Deleting assets created > now() - 1 hour...");

        const res = await pool.query(`
            DELETE FROM cached_assets 
            WHERE created_at > NOW() - INTERVAL '1 hour'
        `);

        console.log(`Deleted ${res.rowCount} stale assets.`);

        // Also clear 'generated_instructions' from exercises to be safe
        console.log("Clearing metadata flags...");
        await pool.query(`
            UPDATE training_exercises 
            SET metadata = metadata - 'generated_instructions'
            WHERE metadata ? 'generated_instructions'
        `);

    } catch (e: any) {
        console.error("Cleanup Failed:", e.message);
    }
    process.exit(0);
}
main();
