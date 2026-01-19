import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function test() {
    try {
        const res = await pool.query("SELECT name FROM training_exercises LIMIT 1");
        if (res.rows.length === 0) {
            console.log("No exercises found");
            return;
        }
        const name = res.rows[0].name;
        console.log("Found exercise:", name);

        // Normalize
        const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
        const key = `ex_${slug}_atlas_main`;
        console.log("Testing key:", key);

        // Simulate Proxy Match Logic
        const movementSlug = slug;
        const searchPattern = movementSlug.replace(/_/g, '%');
        console.log("Search Pattern:", searchPattern);

        const groupRes = await pool.query(
            `SELECT id, name FROM training_exercises 
           WHERE name ILIKE $1 
              OR REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '_', 'g') = $2
              OR REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '_', 'g') LIKE $3
              OR name ILIKE $4
           ORDER BY length(name) ASC
           LIMIT 1`,
            [movementSlug.replace(/_/g, ' '), movementSlug, `%${movementSlug}%`, `%${searchPattern}%`]
        );

        const hardCase = "active_mobility_flow";
        console.log("\nTesting Hard Case:", hardCase);
        const patterns2 = [hardCase.replace(/_/g, ' '), hardCase, `%${hardCase}%`, `%${hardCase.replace(/_/g, '%')}%`];
        const res2 = await pool.query(
            `SELECT id, name FROM training_exercises 
           WHERE name ILIKE $1 
              OR REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '_', 'g') = $2
              OR REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '_', 'g') LIKE $3
              OR name ILIKE $4
           ORDER BY length(name) ASC
           LIMIT 1`,
            patterns2
        );
        console.log("Hard Case Match:", res2.rows[0] || "NONE");

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

test();
