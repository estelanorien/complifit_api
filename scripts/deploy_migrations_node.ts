
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Load Environment Variables
const dirsToCheck = [
    process.cwd(),
    path.resolve(process.cwd(), '..', '..', 'vitality_app-main', 'vitality_app-main')
];

let dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
    for (const dir of dirsToCheck) {
        const envPath = path.join(dir, '.env');
        if (fs.existsSync(envPath)) {
            console.log(`Loading .env from ${envPath}`);
            const envConfig = dotenv.parse(fs.readFileSync(envPath));
            if (envConfig.DATABASE_URL) {
                dbUrl = envConfig.DATABASE_URL;
                // Load other vars just in case
                for (const k in envConfig) {
                    process.env[k] = envConfig[k];
                }
                break;
            }
        }
    }
}

if (!dbUrl) {
    console.error("Error: DATABASE_URL not found in environment or .env files.");
    console.error("Searched in:", dirsToCheck);
    process.exit(1);
}

console.log(`Target Database: ${dbUrl.replace(/:[^:@]*@/, ':****@')}`); // Hide password

const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log("Connected to database.");

        const migrationsDir = path.resolve(__dirname, '..', 'migrations');
        const migrations2Dir = path.join(migrationsDir, 'migrations2');

        const getSqlFiles = (dir) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.sql') && !f.startsWith('test')) // Exclude testdb.sql
                .sort()
                .map(f => ({ name: f, fullPath: path.join(dir, f) }));
        };

        const files1 = getSqlFiles(migrationsDir);
        const files2 = getSqlFiles(migrations2Dir);
        const allFiles = [...files1, ...files2];

        console.log(`Found ${allFiles.length} migration files.`);

        for (const file of allFiles) {
            console.log(`Applying ${file.name}...`);
            const sql = fs.readFileSync(file.fullPath, 'utf8');
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
                console.log(`  -> Success.`);
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  -> Failed: ${err.message}`);
                // Continue? No, migration failure should stop.
                // But user asked to "run scripts", if these are idempotent (IF NOT EXISTS), errors might be "relation already exists" if not handled correctly.
                // However, raw SQL often throws if table exists and IF NOT EXISTS is missing.
                // We assume the SQL files are written robustly or we want to know if they fail.
                // Exception: "002_eat_out_updates.sql" duplicates "002_add...".
                // If logic is duplicated, it might error.
                // We'll throw to stop.
                throw err;
            }
        }

        console.log("All migrations applied successfully.");

    } catch (err) {
        console.error("___________________________________________________");
        console.error("MIGRATION FAILED");
        console.error(err);
        console.error("___________________________________________________");
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
