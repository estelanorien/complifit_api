
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    console.log("--- DEBUG NOVA IMAGE ANALYSIS ---");
    const client = await pool.connect();

    try {
        // 1. Get Reference Image
        const resNova = await client.query("SELECT value FROM cached_assets WHERE key='system_coach_nova_ref'");
        const novaRef = resNova.rows[0]?.value;

        if (!novaRef) throw new Error("Missing Coach Nova Ref in DB");

        // Clean base64
        const base64Data = novaRef.replace(/^data:image\/\w+;base64,/, "");

        console.log("Image fetched. Sending to Gemini Vision for Audit...");

        // 2. Call Gemini Vision (Raw Fetch)
        const apiKey = process.env.GEMINI_API_KEY;
        // Use 2.5 flash as it is multimodal
        const model = 'models/gemini-2.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

        const prompt = "You are a Safety Bot. Analyze this image objectively. Describe the clothing, the amount of exposed skin, the pose, and the facial expression. Does this image look like it could trigger 'Sexually Explicit' or 'Dangerous Content' filters? Be honest.";

        const body = {
            contents: [{
                parts: [
                    { text: prompt },
                    {
                        inlineData: {
                            mimeType: "image/png",
                            data: base64Data
                        }
                    }
                ]
            }]
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errText = await res.text();
            console.log("\n❌ VISION MODEL BLOCKED IT TOO (Hard Fail):");
            console.log(errText);
        } else {
            const data: any = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            const finishReason = data.candidates?.[0]?.finishReason;

            if (finishReason !== 'STOP') {
                console.log(`\n⚠️ BLOCKED BY FILTER: ${finishReason}`);
                console.log("Safety Ratings:", JSON.stringify(data.candidates?.[0]?.safetyRatings, null, 2));
            } else {
                console.log("\n✅ ANALYSIS RESULT:");
                console.log(text);
                console.log("\nSafety Ratings:", JSON.stringify(data.candidates?.[0]?.safetyRatings, null, 2));
            }
        }

    } catch (e) {
        console.error("FATAL:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
