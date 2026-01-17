
import { Pool } from 'pg';
const pool = new Pool({
    connectionString: "postgresql://postgres:6fk23az4_F@104.199.2.9:5432/vitality_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        const res = await pool.query("SELECT key FROM cached_assets WHERE key ILIKE '%jollof%' OR key ILIKE '%archer%'");
        console.log(JSON.stringify(res.rows, null, 2));

        const normalize = (name) => {
            let clean = name.toLowerCase().trim();
            clean = clean.replace(/[^a-z0-9]+/g, ' ');
            const words = clean.split(' ').filter(w => w.length > 0).sort();
            return words.join('_');
        };

        console.log("NORMALIZED_archer: " + normalize("Archer Push-ups"));
        console.log("NORMALIZED_jollof: " + normalize("African Jollof Rice with Chicken"));

    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

run();
