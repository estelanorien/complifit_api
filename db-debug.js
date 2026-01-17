
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const migrationsDir = path.resolve(__dirname, 'migrations');
    const migrations2Dir = path.join(migrationsDir, 'migrations2');

    const getSqlFiles = (dir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.sql') && !f.startsWith('test'))
            .sort()
            .map(f => ({ name: f, fullPath: path.join(dir, f) }));
    };

    const allFiles = [...getSqlFiles(migrationsDir), ...getSqlFiles(migrations2Dir)];

    for (const file of allFiles) {
        process.stdout.write(`Applying ${file.name}... `);
        const sql = fs.readFileSync(file.fullPath, 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
            process.stdout.write(`✅\n`);
        } catch (err) {
            await client.query('ROLLBACK');
            process.stdout.write(`❌\n`);
            console.error(`Error in ${file.name}: ${err.message}`);
            // console.error(err);
            process.exit(1);
        } finally {
            client.release();
        }
    }
    await pool.end();
}

run();
