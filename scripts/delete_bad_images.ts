/**
 * Quick script to delete bad exercise step images from the database
 * Run with: npx tsx scripts/delete_bad_images.ts
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from multiple possible locations - use dotenv.parse() like deploy_migrations_node.ts
const dirsToCheck = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..', 'vitality_app-main', 'vitality_app-main'),
    process.cwd()
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
                break;
            }
        }
    }
}

if (!dbUrl) {
    console.error("DATABASE_URL not found!");
    console.error("Searched in:", dirsToCheck.map(d => path.join(d, '.env')));
    process.exit(1);
}

console.log(`Target Database: ${dbUrl.replace(/:[^:@]*@/, ':****@')}`);

const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log("Deleting bad exercise step images...");

        // Delete step images
        // Delete step images
        const r1 = await client.query(`
            DELETE FROM cached_assets 
            WHERE asset_type = 'image' 
            AND (key LIKE 'movement_%_step_%' OR key LIKE 'movement_%_main')
        `);
        console.log(`Deleted ${r1.rowCount} step and main images`);

        // Delete step metadata
        const r2 = await client.query(`
            DELETE FROM cached_assets 
            WHERE asset_type = 'json' 
            AND key LIKE 'movement_%_step_%_meta'
        `);
        console.log(`Deleted ${r2.rowCount} step metadata entries`);

        console.log("Done! Refresh the app to regenerate fresh images.");
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(console.error);
