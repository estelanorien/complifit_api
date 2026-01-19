
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { AiService } from '../src/application/services/aiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log("--- DEBUG NOVA FAILURE ---");
    const ai = new AiService();
    const client = await pool.connect();

    try {
        // 1. Get Reference Image
        const resNova = await client.query("SELECT value FROM cached_assets WHERE key='system_coach_nova_ref'");
        const novaRef = resNova.rows[0]?.value;

        if (!novaRef) throw new Error("Missing Coach Nova Ref in DB");

        const prompt = "Cinematic fitness photography. Subject: Coach Nova (28yo female, blonde ponytail, athletic, black tank top) running. Perfect execution.";

        console.log("\nTEST 1: Generate WITHOUT Ref (Check Prompt Safety)");
        try {
            const res1 = await ai.generateImage({ prompt });
            console.log("✅ Test 1 Success (Prompt is safe)");
        } catch (e: any) {
            console.error("❌ Test 1 Failed:", e.message);
        }

        console.log("\nTEST 2: Generate WITH Ref (Check Ref Image Safety)");
        try {
            const res2 = await ai.generateImage({
                prompt,
                referenceImage: novaRef
            });
            console.log("✅ Test 2 Success (Ref Image is safe)");
        } catch (e: any) {
            console.error("❌ Test 2 Failed:", e.message);
        }

    } catch (e) {
        console.error("FATAL:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
