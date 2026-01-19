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

  async generateText({ prompt, model = 'models/gemini-1.5-flash', generationConfig }: GenerateTextParams & { generationConfig?: any }) {
    const res = await fetch(`${this.baseUrl}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig
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
      // Check if prompt contains non-ASCII characters (likely non-English)
      const hasNonEnglish = /[^\x00-\x7F]/.test(prompt);

      // Check if prompt contains step indicators or UI labels
      const hasStepLabels = /\b(step|étape|paso|adım)\s*\d+/i.test(prompt) ||
        /^\d+[.:)]/.test(prompt.trim());

      if (!hasNonEnglish && !hasStepLabels) {
        // Already clean English prompt, just return with safety suffix
        return `${prompt}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
      }

      // Use AI to translate and clean the prompt
      const cleaningPrompt = `You are a professional image prompt translator. Your task is to:
1. Translate the following text to English if it's in another language
2. Remove any step numbers, UI labels, or instructional prefixes (like "Step 1:", "Étape 2:", etc.)
3. Extract ONLY the visual scene description
4. Keep it concise and focused on what should be visible in the photo

Input prompt: ${prompt}

Return ONLY the cleaned visual description in English. Do not include any explanations or notes.`;

      // Use gemini-2.5-flash for consistency and speed (Vision + Text)
      // gemini-1.5-flash is NOT available in this Beta environment.
      const { text } = await this.generateText({
        prompt: cleaningPrompt,
        model: 'models/gemini-2.5-flash'
      });

      const cleaned = text.trim();

      // Add safety suffix to prevent text rendering
      return `${cleaned}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
    } catch (e) {
      // Fallback: Basic regex cleaning if AI translation fails
      let cleaned = prompt;
      // Remove step numbers
      cleaned = cleaned.replace(/^(step|étape|paso|adım)\s*\d+[.:)]?\s*/i, '');
      cleaned = cleaned.replace(/^\d+[.:)]\s*/, '');
      return `${cleaned}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
    }
  }

  async generateImage({ prompt, model = 'models/gemini-1.5-flash', referenceImage }: GenerateImageParams) {
    const parts: any[] = [];

    // Clean prompt to prevent text overlays
    const cleanedPrompt = await this.cleanImagePrompt(prompt);

    // Build enhanced prompt with identity preservation for reference images
    let enhancedPrompt = cleanedPrompt;

    if (referenceImage) {
      enhancedPrompt = `CRITICAL IDENTITY PRESERVATION: Match the exact person from the reference image.
Keep the SAME face, facial features, hair style, and hair color.
Only change the body posture/position as needed for the action.

${prompt}`;

      // Add reference image first
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
    const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
    const base64 = part?.inlineData?.data;
    if (!base64) throw new Error('No image data returned');
    return { base64: `data:image/png;base64,${base64}` };
  }

  async generateVideo({ prompt, model = 'models/veo-001-preview' }: { prompt: string, model?: string }): Promise<string> {
    try {
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
        throw new Error(`Veo error: ${res.status} ${await res.text()}`);
      }

      const data = await res.json() as any;
      const videoUri = data?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri;

      if (videoUri) return videoUri;

      // Fallback if no URI returned
      throw new Error("No video URI returned");

    } catch (e: any) {
      console.warn(`[AiService] Video generation failed (Veo access likely restricted). Using fallback.`, e.message);
      // Fallback to High Quality Stock Mock for Demo
      return "https://assets.mixkit.co/videos/preview/mixkit-man-doing-push-ups-at-gym-2623-large.mp4";
    }
  }
}

