import { pool } from './src/infra/db/pool.js';
import fs from 'fs';

const ATLAS_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9/coach_atlas_reference_1768943383279.png';
const NOVA_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9/coach_nova_reference_1768943396358.png';

async function seed() {
    try {
        console.log("Seeding Coach Master Images...");

        if (fs.existsSync(ATLAS_PATH)) {
            const buffer = fs.readFileSync(ATLAS_PATH);
            const base64 = `data:image/png;base64,${buffer.toString('base64')}`;
            await pool.query(`
                INSERT INTO cached_assets (key, value, asset_type, status)
                VALUES ($1, $2, 'image', 'active')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
            `, ['system_coach_atlas_ref', base64]);
            console.log("✅ Coach Atlas Saved");
        }

        if (fs.existsSync(NOVA_PATH)) {
            const buffer = fs.readFileSync(NOVA_PATH);
            const base64 = `data:image/png;base64,${buffer.toString('base64')}`;
            await pool.query(`
                INSERT INTO cached_assets (key, value, asset_type, status)
                VALUES ($1, $2, 'image', 'active')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
            `, ['system_coach_nova_ref', base64]);
            console.log("✅ Coach Nova Saved");
        }

        console.log("Seeding complete.");
    } catch (e: any) {
        console.error("Error:", e.message);
    } finally {
        await pool.end();
    }
}

seed();
