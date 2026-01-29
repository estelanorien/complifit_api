import fetch from 'node-fetch';
import { aiConfig } from '../../config/ai.js';

type GenerateTextParams = {
  prompt: string;
  model?: string;
};

type GenerateImageParams = {
  prompt: string;
  model?: string;
  referenceImage?: string; // Base64
  referenceType?: 'identity' | 'environment';
};

export class AiService {
  private readonly apiKey: string;
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor() {
    this.apiKey = aiConfig.geminiApiKey;
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is required');
    }
  }

  async generateText({ prompt, model = 'models/gemini-3-flash-preview', generationConfig }: GenerateTextParams & { generationConfig?: any }) {
    const res = await fetch(`${this.baseUrl}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: generationConfig || {
          temperature: 0.1,
          topP: 1,
          maxOutputTokens: 2048
        }
      })
    });
    if (!res.ok) {
      const text = await res.text();
      const isProduction = process.env.NODE_ENV === 'production';
      throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini text error: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { text };
  }

  /**
   * Clean and translate image prompts to prevent text overlays
   * Removes step numbers, UI labels, and translates to English
   */
  async cleanImagePrompt(prompt: string): Promise<string> {
    try {
      // CRITICAL BYPASS: Do NOT clean identity-critical prompts
      const lower = prompt.toLowerCase();
      if (lower.includes('coach atlas') || lower.includes('coach nova') || lower.includes('mannequin')) {
        // Add text-suppression suffix even to identity prompts
        return `${prompt}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
      }

      const hasNonEnglish = /[^\x00-\x7F]/.test(prompt);
      const hasStepLabels = /\b(step|étape|paso|adım)\s*\d+/i.test(prompt) || /^\d+[.:)]/.test(prompt.trim());

      if (!hasNonEnglish && !hasStepLabels) {
        return `${prompt}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
      }

      const cleaningPrompt = `You are a professional image prompt translator. Your task is to:
1. Translate to English if needed.
2. Remove step numbers and UI labels.
3. Extract ONLY visual scene description.
Input prompt: ${prompt}
Return ONLY cleaned visual description.`;

      const { text } = await this.generateText({
        prompt: cleaningPrompt,
        model: 'models/gemini-1.5-flash'
      });

      return `${text.trim()}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
    } catch (e) {
      let cleaned = prompt.replace(/^(step|étape|paso|adım)\s*\d+[.:)]?\s*/i, '').replace(/^\d+[.:)]\s*/, '');
      return `${cleaned}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
    }
  }

  async generateImage({ prompt, model = 'models/gemini-2.5-flash-image', referenceImage, referenceType = 'identity' }: GenerateImageParams) {
    console.log(`[AiService] generateImage called with model: ${model}, type: ${referenceType}`);
    console.log(`[AiService] Prompt length: ${prompt?.length}, HasReference: ${!!referenceImage}`);

    const parts: any[] = [];
    const cleanedPrompt = await this.cleanImagePrompt(prompt);
    let enhancedPrompt = cleanedPrompt;

    if (referenceImage) {
      // CRITICAL: Put image FIRST, then text prompt - order matters for identity preservation
      const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: base64Data
        }
      });

      if (referenceType === 'environment') {
        enhancedPrompt = `CRITICAL ENVIRONMENT REPLICATION INSTRUCTIONS:

STEP 1: ANALYZE THE REFERENCE SETTING ABOVE
Note the:
- Background environment (gym, kitchen, etc.)
- Lighting style (dark, moody, bright, natural)
- Specific equipment or decor visible
- Overall color palette and atmosphere

STEP 2: REPLICATE THE SETTING
Generate an image where the subject is performing the requested action, but placed in the EXACT SAME environment shown above.
- LIGHTING MUST MATCH - if reference is dark and moody, output MUST be dark and moody.
- BACKGROUND DETAILS MUST MATCH - replicate the floor style, equipment presence, and wall textures.
- ATMOSPHERE MUST MATCH

STEP 3: THE ACTION
Action to generate: ${cleanedPrompt}

FORBIDDEN:
🚫 Changing the environment or lighting
🚫 Adding unexpected background elements
🚫 Low resolution or blurry backgrounds`;
      } else {
        enhancedPrompt = `CRITICAL IDENTITY REPLICATION INSTRUCTIONS:

STEP 1: ANALYZE THE REFERENCE IMAGE ABOVE
Look at the person in the reference image and note:
- Their EXACT hair color (blonde/dark blonde/brown/etc)
- Their EXACT hairstyle (short, medium, long, ponytail, etc)
- Their facial features
- Their body type and skin tone

STEP 2: REPLICATE EXACTLY
Generate an image where the SAME EXACT PERSON is performing an exercise.
- HAIR COLOR MUST MATCH EXACTLY - if reference has golden/dark blonde hair, output MUST have golden/dark blonde hair (NOT black, NOT brown)
- HAIR STYLE MUST MATCH - same length, same cut
- Face MUST match reference
- NEVER generate a bald person

STEP 3: THE ACTION
The person is performing: ${cleanedPrompt}

FORBIDDEN:
🚫 Black hair when reference has blonde hair
🚫 Bald head
🚫 Different person
🚫 Multiple people
🚫 Split screen or before/after`;
      }
    }

    parts.push({ text: enhancedPrompt });

    console.log(`[AiService] Sending request to: ${this.baseUrl}/${model}:generateContent`);

    const requestBody = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"]
      }
    };

    const res = await fetch(`${this.baseUrl}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[AiService] ❌ API Error: ${res.status} - ${text}`);
      throw new Error(`Gemini image error: ${res.status} - ${text.substring(0, 500)}`);
    }

    const data = await res.json() as any;
    console.log(`[AiService] Response received. Candidates: ${data?.candidates?.length || 0}`);

    // Check for safety blocks
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      console.error(`[AiService] ❌ SAFETY BLOCK detected`);
      throw new Error('SAFETY_BLOCK: The generated content was blocked by AI safety filters.');
    }

    const part = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);
    const base64 = part?.inlineData?.data;
    if (!base64) {
      console.error(`[AiService] ❌ No image data in response:`, JSON.stringify(data).substring(0, 500));
      throw new Error('No image data returned from API');
    }

    console.log(`[AiService] ✅ Image generated successfully (base64 length: ${base64.length})`);
    return { base64: `data:image/png;base64,${base64}` };
  }

  async generateVideo({ prompt }: { prompt: string; model?: string }): Promise<string> {
    // Veo via Gemini API: predictLongRunning + poll (see https://ai.google.dev/gemini-api/docs/video)
    const modelsToTry = ['models/veo-3.1-generate-preview', 'models/veo-3.1-fast-generate-preview', 'models/veo-3.0-generate-001'];
    const pollIntervalMs = 10000;
    const maxWaitMs = 360000;

    for (const model of modelsToTry) {
      try {
        const startRes = await fetch(`${this.baseUrl}/${model}:predictLongRunning`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey
          },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { aspectRatio: '16:9' }
          })
        });

        if (!startRes.ok) {
          if (startRes.status === 404) continue;
          throw new Error(`Veo start error (${startRes.status}): ${await startRes.text()}`);
        }

        const startData = (await startRes.json()) as any;
        const opName = startData?.name;
        if (!opName) continue;

        let waited = 0;
        while (waited < maxWaitMs) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          waited += pollIntervalMs;
          const pollRes = await fetch(`${this.baseUrl}/${opName}`, {
            headers: { 'x-goog-api-key': this.apiKey }
          });
          if (!pollRes.ok) throw new Error(`Veo poll error: ${pollRes.status}`);
          const pollData = (await pollRes.json()) as any;
          if (pollData?.done) {
            const videoUri =
              pollData?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
              pollData?.response?.generatedSamples?.[0]?.video?.uri;
            if (videoUri) return videoUri;
            throw new Error('Veo returned no video URI');
          }
        }
        throw new Error('Veo timed out waiting for video');
      } catch (e: any) {
        if (e.message?.includes('404') || e.message?.includes('not found')) continue;
        throw e;
      }
    }

    throw new Error('Video generation failed: No Veo models available. Ensure API key has Veo access (paid preview).');
  }
}

