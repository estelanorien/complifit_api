/**
 * Direct Imagen-3 API Test Script
 * Tests the image generation API directly to capture exact error responses
 */

import { env } from '../src/config/env.js';

async function main() {
    console.log("=== Direct Imagen-3 API Test ===\n");

    const apiKey = env.geminiApiKey;
    if (!apiKey) {
        console.error("ERROR: GEMINI_API_KEY not set");
        return;
    }
    console.log(`API Key: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`);

    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    const model = 'models/imagen-3.0-generate-001';

    // Simple prompt without reference image
    const simplePrompt = "A bald athletic man doing push-ups in a gym. Professional fitness photography. No text.";

    console.log(`\nModel: ${model}`);
    console.log(`Prompt: "${simplePrompt}"`);

    try {
        console.log("\nSending request to Imagen-3...");

        const res = await fetch(`${baseUrl}/${model}:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: simplePrompt }]
                }],
                generationConfig: {
                    responseModalities: ["IMAGE"]
                }
            })
        });

        console.log(`Response Status: ${res.status} ${res.statusText}`);

        const data = await res.json();

        if (!res.ok) {
            console.log("\n=== ERROR RESPONSE ===");
            console.log(JSON.stringify(data, null, 2));
            return;
        }

        const candidate = data?.candidates?.[0];
        if (candidate?.finishReason === 'SAFETY') {
            console.log("\n=== SAFETY BLOCK ===");
            console.log(JSON.stringify(candidate, null, 2));
            return;
        }

        const part = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);
        if (part?.inlineData?.data) {
            console.log("\n=== SUCCESS ===");
            console.log(`Image data length: ${part.inlineData.data.length} characters`);
        } else {
            console.log("\n=== NO IMAGE DATA ===");
            console.log(JSON.stringify(data, null, 2));
        }

    } catch (e: any) {
        console.error("\n=== EXCEPTION ===");
        console.error(e.message);
    }
}

main();
