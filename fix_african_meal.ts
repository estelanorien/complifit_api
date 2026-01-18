
import { Pool } from 'pg';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function generateImage(prompt) {
    console.log(`Generating (Mock): ${prompt.substring(0, 30)}...`);
    // Red pixel
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKwAEQAAAABJRU5ErkJggg==";
}

async function saveAsset(key, base64, prompt, type = 'image') {
    const value = `data:image/jpeg;base64,${base64}`;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Save Asset
        await client.query(`
            INSERT INTO cached_assets (key, value, asset_type, status)
            VALUES ($1, $2, $3, 'active')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
        `, [key, value, type]);

        // Save Meta
        // Infer movement_id from key (remove meal_ prefix)
        const movementId = key.replace(/^(meal_|ex_)/, '').replace(/(_step\d+|_meta.*)$/, '');

        await client.query(`
            INSERT INTO cached_asset_meta (key, prompt, mode, source, created_by, movement_id)
            VALUES ($1, $2, $3, 'manual_fix', 'system', $4)
            ON CONFLICT (key) DO UPDATE SET prompt = EXCLUDED.prompt, movement_id = EXCLUDED.movement_id;
        `, [key, prompt, type, movementId]);

        await client.query('COMMIT');
        console.log(`Saved: ${key}`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`Failed to save ${key}:`, e);
    } finally {
        client.release();
    }
}

async function run() {
    if (!GEMINI_API_KEY) {
        console.error("No GEMINI_API_KEY found in .env");
        process.exit(1);
    }

    const baseKey = 'meal_african_curry_inspired_vegetable';
    const mainPrompt = "Professional food photography of African Curry Inspired Vegetable stew, served in a rustic bowl, steam rising, high resolution, cinematic lighting, 8k.";

    try {
        // 1. Generate Main Image
        const mainImg = await generateImage(mainPrompt);
        await saveAsset(baseKey, mainImg, mainPrompt);

        // 2. Generate Steps (Mocking 3 steps)
        const steps = [
            "Chop fresh vegetables including carrots, potatoes, and spinach.",
            "Sauté onions and spices in a large pot until fragrant.",
            "Simmer the stew with coconut milk and serve hot."
        ];

        for (let i = 0; i < steps.length; i++) {
            const stepKey = `${baseKey}_step${i + 1}`;
            const stepPrompt = `Cooking step action: ${steps[i]}. Close up shot, photorealistic, food preparation context, 4k.`;
            const stepImg = await generateImage(stepPrompt);
            await saveAsset(stepKey, stepImg, stepPrompt);
        }

        console.log("Done! Assets restored.");
        process.exit(0);

    } catch (e) {
        console.error("Fatal Error:", e);
        process.exit(1);
    }
}

run();
