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

  async generateImage({ prompt, model = 'models/gemini-3-pro-image-preview', referenceImage }: GenerateImageParams) {
    const parts: any[] = [];
    const cleanedPrompt = await this.cleanImagePrompt(prompt);
    let enhancedPrompt = cleanedPrompt;

    if (referenceImage) {
      enhancedPrompt = `IDENTITY REPLICATION: Copy the EXACT appearance from the reference image:
- Same FACE (eyes, nose, mouth, facial structure)
- Same HAIR (hairstyle, hair color, hair length, hair texture - DO NOT make them bald)
- Same BODY TYPE and BUILD
- Same SKIN TONE and ETHNICITY

CRITICAL RULES:
- ONLY ONE PERSON in the image
- NO split screens, NO before/after comparisons
- Follow the clothing colors specified in the action description
- The person MUST have the same hairstyle as the reference - NOT BALD

ACTION: ${cleanedPrompt}`;

      const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: base64Data
        }
      });
    }

    parts.push({ text: enhancedPrompt });

    const res = await fetch(`${this.baseUrl}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"]
        }
      })
    });
    if (!res.ok) {
      const text = await res.text();
      const isProduction = process.env.NODE_ENV === 'production';
      throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini image error: ${res.status} ${text}`);
    }

    const data = await res.json() as any;

    // Check for safety blocks
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      throw new Error('SAFETY_BLOCK: The generated content was blocked by AI safety filters.');
    }

    const part = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);
    const base64 = part?.inlineData?.data;
    if (!base64) throw new Error('No image data returned');
    return { base64: `data:image/png;base64,${base64}` };
  }

  async generateVideo({ prompt, model = 'models/veo-001-preview' }: { prompt: string, model?: string }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Veo API error (${res.status}): ${errorText}`);
    }

    const data = await res.json() as any;
    const videoUri = data?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri;

    if (!videoUri) {
      throw new Error("Veo API returned no video URI. Response: " + JSON.stringify(data));
    }

    return videoUri;
  }
}

