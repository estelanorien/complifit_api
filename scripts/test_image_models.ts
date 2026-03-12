/**
 * Test Gemini 3 Pro Image model (the correct one)
 */

import { env } from '../src/config/env.js';

async function main() {
    console.log("=== Gemini 3 Pro Image Test ===\n");

    const apiKey = env.geminiApiKey;
    if (!apiKey) {
        console.error("ERROR: GEMINI_API_KEY not set");
        return;
    }

    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

    // Try the correct model names
    const modelsToTry = [
        'models/gemini-3-pro-image-preview',
        'models/gemini-2.0-flash-exp',
        'models/gemini-2.5-flash-image'
    ];

    const simplePrompt = "A bald athletic man doing push-ups in a gym. Professional fitness photography. No text.";

    for (const model of modelsToTry) {
        console.log(`\n--- Testing: ${model} ---`);

        try {
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

            console.log(`Status: ${res.status} ${res.statusText}`);

            if (res.ok) {
                const data = await res.json() as any;
                const candidate = data?.candidates?.[0];
                const part = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);

                if (part?.inlineData?.data) {
                    console.log(`SUCCESS! Image data: ${part.inlineData.data.length} chars`);
                    console.log(`\n==> WORKING MODEL: ${model} <==`);
                    break;
                } else {
                    console.log("No image data in response");
                }
            } else {
                const data = await res.json();
                console.log(`Error: ${JSON.stringify(data.error?.message || data).substring(0, 150)}`);
            }
        } catch (e: any) {
            console.log(`Exception: ${e.message}`);
        }
    }
}

main();
