
import { Pool } from 'pg';
const pool = new Pool({
    connectionString: "postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("--- Jollof Keys ---");
        const res1 = await pool.query("SELECT key FROM cached_assets WHERE key ILIKE '%jollof%'");
        res1.rows.forEach(r => console.log(r.key));

        console.log("\n--- Archer Keys ---");
        const res2 = await pool.query("SELECT key FROM cached_assets WHERE key ILIKE '%archer%'");
        res2.rows.forEach(r => console.log(r.key));

        // Also check how normalize works if we can simulate it
        const normalize = (name) => {
            let clean = name.toLowerCase().trim();
            clean = clean.replace(/[^a-z0-9]+/g, ' ');
            const words = clean.split(' ').filter(w => w.length > 0).sort();
            return words.join('_');
        };

        console.log("\n--- Normalized Names ---");
        console.log("African Jollof Rice with Chicken ->", normalize("African Jollof Rice with Chicken"));
        console.log("Archer Push-ups ->", normalize("Archer Push-ups"));

    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

run();
