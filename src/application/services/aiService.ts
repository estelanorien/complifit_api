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

  async generateImage({ prompt, model = 'models/gemini-1.5-flash-preview-04-17', referenceImage }: GenerateImageParams) {
    const parts: any[] = [];

    // Build enhanced prompt with identity preservation for reference images
    let enhancedPrompt = prompt;

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
          responseModalities: ['image', 'text'],
          responseMimeType: 'image/png'
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
}

