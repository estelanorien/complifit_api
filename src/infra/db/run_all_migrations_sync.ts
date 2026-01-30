import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env from project root (vitality_api-main/vitality_api-main), then workspace root (vitapp2) so DATABASE_URL is found
const projectRoot = path.join(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
if (!process.env.DATABASE_URL) {
    const workspaceEnv = path.join(projectRoot, '..', '..', '.env');
    dotenv.config({ path: workspaceEnv });
}
dotenv.config(); // override with process env / cwd .env

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('DATABASE_URL is required. Set it in .env or environment.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('104.199') || DATABASE_URL.includes('cloudsql') || process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined
});

async function runAll() {
    const migrationsDir = path.join(__dirname, '..', '..', '..', 'migrations');

    // Get all SQL files and sort them
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    console.log(`Found ${files.length} migration files. Starting sync...`);

    for (const file of files) {
        const sqlPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log(`Applying ${file}...`);
        try {
            await pool.query(sql);
            console.log(`✅ ${file} applied.`);
        } catch (err: any) {
            // Some migrations might fail if objects already exist and "IF NOT EXISTS" wasn't used,
            // but we'll log those and continue.
            console.warn(`⚠️  ${file} had issues: ${err.message}`);
        }
    }

    // Also check migrations2 folder if it exists
    const migrations2Dir = path.join(migrationsDir, 'migrations2');
    if (fs.existsSync(migrations2Dir)) {
        const files2 = fs.readdirSync(migrations2Dir)
            .filter(f => f.endsWith('.sql'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        console.log(`Processing migrations2 folder (${files2.length} files)...`);
        for (const file of files2) {
            const sqlPath = path.join(migrations2Dir, file);
            const sql = fs.readFileSync(sqlPath, 'utf8');
            console.log(`Applying migrations2/${file}...`);
            try {
                await pool.query(sql);
                console.log(`✅ migrations2/${file} applied.`);
            } catch (err: any) {
                console.warn(`⚠️  migrations2/${file} had issues: ${err.message}`);
            }
        }
    }

    console.log('All migrations processed.');
    await pool.end();
}

runAll();
