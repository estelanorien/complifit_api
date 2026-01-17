
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: 'c:/Users/rmkoc/Downloads/vitapp2/vitality_api-main/vitality_api-main/.env' });

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error("No API KEY found in .env");
    process.exit(1);
}

async function testImageGen() {
    console.log("Testing gemini-2.5-flash-image generation...");
    const model = 'models/gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

    const body = {
        contents: [{
            parts: [{ text: "Fitness photography: pushups exercise. Proper form, athletic model, gym setting, cinematic lighting, 8k resolution, professional quality." }]
        }],
        generationConfig: {
            responseModalities: ["IMAGE"]
        }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': API_KEY
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const txt = await res.text();
            console.error(`FAILED: ${res.status}`);
            console.error(txt);
        } else {
            console.log("SUCCESS!");
            const data = await res.json();
            console.log(JSON.stringify(data, null, 2).substring(0, 500) + "...");
        }
    } catch (e) {
        console.error("Exception:", e);
    }
}

testImageGen();
