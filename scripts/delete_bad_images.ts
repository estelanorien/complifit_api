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

// Load env from multiple possible locations
const envPaths = [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', 'vitality_app-main', 'vitality_app-main', '.env'),
    path.resolve(process.cwd(), '.env')
];

for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        console.log(`Loading .env from ${envPath}`);
        dotenv.config({ path: envPath });
        break;
    }
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    console.error("DATABASE_URL not found!");
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log("Deleting bad exercise step images...");

        // Delete step images
        const r1 = await client.query(`
            DELETE FROM assets 
            WHERE asset_type = 'image' 
            AND key LIKE 'movement_%_step_%'
        `);
        console.log(`Deleted ${r1.rowCount} step images`);

        // Delete step metadata
        const r2 = await client.query(`
            DELETE FROM assets 
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
