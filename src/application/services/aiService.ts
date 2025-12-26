import fetch from 'node-fetch';
import { aiConfig } from '../../config/ai';

type GenerateTextParams = {
  prompt: string;
  model?: string;
};

type GenerateImageParams = {
  prompt: string;
  model?: string;
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

  async generateText({ prompt, model = 'models/gemini-1.5-flash' }: GenerateTextParams) {
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
      const text = await res.text();
      const isProduction = process.env.NODE_ENV === 'production';
      throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini text error: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { text };
  }

  async generateImage({ prompt, model = 'models/gemini-2.0-flash-exp' }: GenerateImageParams) {
    const res = await fetch(`${this.baseUrl}/${model}:generateContent`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'image/png' }
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

