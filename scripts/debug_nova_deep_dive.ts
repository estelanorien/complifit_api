
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

// Path to the approved Safe Headshot
const SAFE_HEADSHOT_PATH = 'C:/Users/rmkoc/.gemini/antigravity/brain/bd4eab35-474c-440c-ab28-e40d24b54ef9/coach_nova_headshot_safe_1768855506416.png';

async function run() {
    console.log("--- DEEP DIVE: NOVA HEADSHOT FAILURE ANALYSIS ---");

    if (!fs.existsSync(SAFE_HEADSHOT_PATH)) {
        throw new Error(`File not found: ${SAFE_HEADSHOT_PATH}`);
    }
    const buffer = fs.readFileSync(SAFE_HEADSHOT_PATH);
    const base64Data = buffer.toString('base64');
    console.log("Headshot loaded.");

    const apiKey = process.env.GEMINI_API_KEY;
    const model = 'models/gemini-2.5-flash-image'; // The model being used
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

    // Test Scenarios
    const scenarios = [
        {
            name: "Simple Portrait (Control)",
            prompt: "Portrait of this woman standing in a garden. Conservative clothing."
        },
        {
            name: "The Failing Prompt (Sprint)",
            prompt: "Cinematic fitness photography. High contrast, dramatic lighting, 8k. Subject: 25m Sprint 25m Slow performed by Coach Nova (28yo female, blonde ponytail, athletic, high-neck black t-shirt). Perfect execution."
        }
    ];

    for (const test of scenarios) {
        console.log(`\nTesting: ${test.name}`);
        const body = {
            contents: [{
                parts: [
                    { text: test.prompt },
                    {
                        inlineData: {
                            mimeType: "image/png",
                            data: base64Data
                        }
                    }
                ]
            }],
            generationConfig: {
                responseModalities: ["IMAGE"]
            }
        };

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const err = await res.text();
                console.log(`❌ API HTTP Error: ${res.status}`);
                console.log(err);
                continue;
            }

            const data: any = await res.json();

            // Check for Safety Ratings
            if (data.candidates && data.candidates[0]) {
                const candidate = data.candidates[0];
                console.log(`Finish Reason: ${candidate.finishReason}`);

                if (candidate.safetyRatings) {
                    console.log("Safety Ratings:");
                    candidate.safetyRatings.forEach((r: any) => {
                        console.log(`  - ${r.category}: ${r.probability}`);
                    });
                }

                if (candidate.content && candidate.content.parts && candidate.content.parts[0].inlineData) {
                    console.log("✅ SUCCESS: Image Generated (Base64 received)");
                } else {
                    console.log("❌ FAILURE: No image data in candidate content.");
                }
            } else {
                console.log("❌ FAILURE: No candidates returned.");
                if (data.promptFeedback) {
                    console.log("Prompt Feedback:", JSON.stringify(data.promptFeedback, null, 2));
                }
            }

        } catch (e: any) {
            console.error("FATAL Exception:", e.message);
        }
    }
}

run();
