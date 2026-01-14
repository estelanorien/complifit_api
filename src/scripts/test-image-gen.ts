
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
    console.log("Testing gemini-2.0-flash-exp image generation...");
    const model = 'models/gemini-2.0-flash-exp';
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${API_KEY}`;

    const body = {
        contents: [{
            parts: [{ text: "A futuristic city with flying cars, cinematic lighting, 8k" }]
        }],
        generationConfig: {
            responseModalities: ["image"], // Try strictly image
            responseMimeType: "image/jpeg"
        }
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
