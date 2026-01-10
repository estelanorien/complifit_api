
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    // Try frontend env
    const frontendEnv = path.resolve(__dirname, '..', '..', 'vitality_app-main', 'vitality_app-main', '.env');
    if (fs.existsSync(frontendEnv)) {
        dotenv.config({ path: frontendEnv });
    }
}

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const ATLAS_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/a50c7246-896e-48e3-92b6-f034bf520830/coach_atlas_variation_2_1768082210632.png';
const NOVA_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/a50c7246-896e-48e3-92b6-f034bf520830/coach_nova_variation_2_1768082224743.png';

async function seed() {
    const client = await pool.connect();
    try {
        console.log("Seeding Coach Master Images...");

        // 1. Atlas
        if (fs.existsSync(ATLAS_PATH)) {
            const buffer = fs.readFileSync(ATLAS_PATH);
            const base64 = `data:image/png;base64,${buffer.toString('base64')}`;
            await client.query(`
                INSERT INTO cached_assets (key, value, asset_type, status)
                VALUES ($1, $2, 'image', 'active')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
            `, ['system_coach_atlas_ref', base64]);
            console.log("✅ Coach Atlas Saved");
        } else {
            console.error("❌ Atlas image not found at", ATLAS_PATH);
        }

        // 2. Nova
        if (fs.existsSync(NOVA_PATH)) {
            const buffer = fs.readFileSync(NOVA_PATH);
            const base64 = `data:image/png;base64,${buffer.toString('base64')}`;
            await client.query(`
                INSERT INTO cached_assets (key, value, asset_type, status)
                VALUES ($1, $2, 'image', 'active')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
            `, ['system_coach_nova_ref', base64]);
            console.log("✅ Coach Nova Saved");
        } else {
            console.error("❌ Nova image not found at", NOVA_PATH);
        }

    } catch (e) {
        console.error("Error seeding coaches:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

seed();
