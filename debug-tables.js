
import { Pool } from 'pg';
const pool = new Pool({
    connectionString: "postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("--- Tables ---");
        const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
        tables.rows.forEach(r => console.log(r.table_name));

        console.log("\n--- Meals (Definition) ---");
        const meals = await pool.query("SELECT name FROM meals WHERE name ILIKE '%jollof%'");
        console.log(JSON.stringify(meals.rows, null, 2));

        console.log("\n--- Exercises (Definition) ---");
        const ex = await pool.query("SELECT name FROM training_exercises WHERE name ILIKE '%archer%'");
        console.log(JSON.stringify(ex.rows, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

run();
