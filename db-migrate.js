import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrate() {
    console.log('Starting DB migration on:', process.env.DATABASE_URL?.split('@')[1]);
    const client = await pool.connect();
    try {
        // 1. Create migration tracking table
        await client.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT UNIQUE NOT NULL,
                applied_at TIMESTAMPTZ DEFAULT now()
            )
        `);

        // 2. Get already-applied migrations
        const { rows: applied } = await client.query('SELECT filename FROM _migrations ORDER BY filename');
        const appliedSet = new Set(applied.map(r => r.filename));

        // 3. Read migration files from /migrations directory
        const migrationsDir = path.join(__dirname, 'migrations');
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort(); // Sorted alphabetically (001_, 002_, etc.)

        let appliedCount = 0;
        let skippedCount = 0;

        for (const file of files) {
            if (appliedSet.has(file)) {
                skippedCount++;
                continue;
            }

            const filePath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(filePath, 'utf-8');

            console.log(`Applying migration: ${file}...`);
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log(`  ✓ ${file} applied successfully`);
                appliedCount++;
            } catch (e) {
                await client.query('ROLLBACK');
                console.error(`  ✗ ${file} FAILED: ${e.message}`);
                if (e.detail) console.error(`    Detail: ${e.detail}`);
                // Continue with next migration (some may depend on manual steps)
                // Record the failure but don't stop - this allows idempotent re-runs
                console.log(`    Skipping failed migration and continuing...`);
            }
        }

        console.log(`\nMigration complete: ${appliedCount} applied, ${skippedCount} already up-to-date, ${files.length} total`);
    } catch (e) {
        console.error('Migration system FAILED CRITICALLY:');
        console.error('Message:', e.message);
        console.error('Stack:', e.stack);
        if (e.detail) console.error('Detail:', e.detail);
        if (e.hint) console.error('Hint:', e.hint);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
