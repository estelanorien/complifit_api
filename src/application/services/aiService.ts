import fetch from 'node-fetch';
import { aiConfig } from '../../config/ai.js';
import { aiRouter, AITaskType } from './AIRouter.js';
import { claudeService } from './ClaudeService.js';
import { warroomSkillService } from './WarroomSkillService.js';
import { logger } from '../../infra/logger.js';

type GenerateTextParams = {
  prompt: string;
  model?: string;
  /** Optional task type for intelligent routing via AIRouter */
  taskType?: AITaskType;
  /** Optional system prompt (used with Claude) */
  systemPrompt?: string;
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

  /**
   * Generate text using the optimal model for the task.
   * If taskType is provided, AIRouter selects the best provider (Claude or Gemini).
   * Falls back to Gemini if Claude fails.
   */
  async generateText({ prompt, model, taskType, systemPrompt, generationConfig }: GenerateTextParams & { generationConfig?: any }) {
    // Compose warroom skill prompts if task type specified
    const effectiveSystemPrompt = taskType
      ? this.composeSkillPrompt(taskType, systemPrompt)
      : systemPrompt;

    // Route through AIRouter if task type is specified
    if (taskType) {
      const route = aiRouter.route(taskType);

      if (route.provider === 'anthropic') {
        try {
          return await claudeService.generateText({
            prompt,
            systemPrompt: effectiveSystemPrompt,
            model: route.model,
            maxTokens: route.maxOutputTokens || 4096,
          });
        } catch (e: any) {
          // Fallback to Gemini on Claude failure
          logger.warn(`[AiService] Claude failed for ${taskType}, falling back to Gemini: ${e.message}`);
        }
      }
    }

    // Gemini path (default or fallback)
    const geminiModel = model || 'models/gemini-3-flash-preview';
    const res = await fetch(`${this.baseUrl}/${geminiModel}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(effectiveSystemPrompt ? { systemInstruction: { role: 'system', parts: [{ text: effectiveSystemPrompt }] } } : {}),
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
   * Generate structured JSON output using the optimal model.
   * Prefers Claude for structured output (guaranteed JSON compliance).
   */
  async generateStructuredOutput<T = any>({ prompt, taskType, systemPrompt, schema, model }: {
    prompt: string;
    taskType?: AITaskType;
    systemPrompt?: string;
    schema?: string;
    model?: string;
  }): Promise<{ data: T; raw: string }> {
    if (taskType) {
      const route = aiRouter.route(taskType);
      const effectiveSystemPrompt = this.composeSkillPrompt(taskType, systemPrompt);
      if (route.provider === 'anthropic') {
        try {
          return await claudeService.generateStructuredOutput<T>({
            prompt,
            systemPrompt: effectiveSystemPrompt,
            model: route.model,
            maxTokens: route.maxOutputTokens || 8192,
            schema,
          });
        } catch (e: any) {
          logger.warn(`[AiService] Claude structured output failed for ${taskType}, falling back to Gemini: ${e.message}`);
        }
      }
    }

    // Gemini fallback for structured output
    const { text } = await this.generateText({
      prompt: prompt + (schema ? `\n\nReturn ONLY valid JSON matching this schema:\n${schema}` : '\n\nReturn ONLY valid JSON.'),
      model,
      generationConfig: { responseMimeType: 'application/json' }
    });

    // Extract JSON
    const jsonStr = text.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
    const data = JSON.parse(jsonStr) as T;
    return { data, raw: text };
  }

  /**
   * Multi-turn chat using the optimal model.
   * Converts Gemini history format ({role:'user'|'model', parts:[{text}]}) to Claude format.
   * Falls back to Gemini if Claude is unavailable.
   */
  async generateChat({ messages, systemPrompt, taskType }: {
    messages: Array<{ role: string; parts?: Array<{ text: string }>; content?: string }>;
    systemPrompt?: string;
    taskType?: AITaskType;
  }): Promise<{ text: string }> {
    // Normalize to Claude message format
    const claudeMessages = messages.map(m => ({
      role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
      content: m.content || m.parts?.map(p => p.text).join('') || '',
    }));

    // Compose warroom skill prompts if attached
    const effectiveSystemPrompt = taskType
      ? this.composeSkillPrompt(taskType, systemPrompt)
      : systemPrompt;

    if (taskType) {
      const route = aiRouter.route(taskType);
      if (route.provider === 'anthropic') {
        try {
          return await claudeService.generateChat({
            messages: claudeMessages,
            systemPrompt: effectiveSystemPrompt,
            model: route.model,
            maxTokens: route.maxOutputTokens || 4096,
          });
        } catch (e: any) {
          logger.warn(`[AiService] Claude chat failed for ${taskType}, falling back to Gemini: ${e.message}`);
        }
      }
    }

    // Gemini fallback: use native multi-turn format
    const geminiContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: m.parts || [{ text: m.content || '' }],
    }));

    const res = await fetch(`${this.baseUrl}/models/gemini-3-flash-preview:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: geminiContents,
        ...(effectiveSystemPrompt ? { systemInstruction: { role: 'system', parts: [{ text: effectiveSystemPrompt }] } } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      const isProduction = process.env.NODE_ENV === 'production';
      throw new Error(isProduction ? `AI service error (${res.status})` : `Gemini chat error: ${res.status} ${text}`);
    }
    const data = await res.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { text };
  }

  /**
   * Clean and translate image prompts to prevent text overlays.
   * Always uses Gemini Flash (cheapest, simple task).
   */
  async cleanImagePrompt(prompt: string): Promise<string> {
    try {
      const hasNonEnglish = /[^\x00-\x7F]/.test(prompt);
      const hasStepLabels = /\b(step|étape|paso|adım)\s*\d+/i.test(prompt) ||
        /^\d+[.:)]/.test(prompt.trim());

      if (!hasNonEnglish && !hasStepLabels) {
        return `${prompt}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
      }

      const cleaningPrompt = `You are a professional image prompt translator. Your task is to:
1. Translate the following text to English if it's in another language
2. Remove any step numbers, UI labels, or instructional prefixes (like "Step 1:", "Étape 2:", etc.)
3. Extract ONLY the visual scene description
4. Keep it concise and focused on what should be visible in the photo

Input prompt: ${prompt}

Return ONLY the cleaned visual description in English. Do not include any explanations or notes.`;

      const { text } = await this.generateText({
        prompt: cleaningPrompt,
        model: 'models/gemini-2.0-flash',  // Cheapest model for simple task
        taskType: 'clean_prompt'
      });

      const cleaned = text.trim();
      return `${cleaned}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
    } catch (e) {
      let cleaned = prompt;
      cleaned = cleaned.replace(/^(step|étape|paso|adım)\s*\d+[.:)]?\s*/i, '');
      cleaned = cleaned.replace(/^\d+[.:)]\s*/, '');
      return `${cleaned}. CRITICAL: Absolutely no text, labels, numbers, letters, words, captions, or watermarks in the image.`;
    }
  }

  /**
   * Compose warroom skill system prompt for a task.
   * Returns the original systemPrompt if no skills attached.
   */
  private composeSkillPrompt(taskType: AITaskType, systemPrompt?: string): string | undefined {
    const skillIds = aiRouter.getSkillIds(taskType);
    if (skillIds.length === 0) return systemPrompt;

    const skillPrompt = warroomSkillService.composePrompt(skillIds);
    if (!skillPrompt) return systemPrompt;

    return skillPrompt + (systemPrompt ? '\n\n' + systemPrompt : '');
  }

  /**
   * Generate image — always uses Gemini Imagen (no change).
   */
  async generateImage({ prompt, model = 'models/gemini-2.5-flash-image', referenceImage }: GenerateImageParams) {
    const parts: any[] = [];
    const cleanedPrompt = await this.cleanImagePrompt(prompt);
    let enhancedPrompt = cleanedPrompt;

    if (referenceImage) {
      enhancedPrompt = `CRITICAL IDENTITY PRESERVATION: Match the exact person from the reference image.
Keep the SAME face, facial features, hair style, and hair color.
Only change the body posture/position as needed for the action.

${prompt}`;

      const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, "");
      parts.push({
        inlineData: { mimeType: 'image/png', data: base64Data }
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
        generationConfig: { responseModalities: ["IMAGE"] }
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

  /**
   * Generate video — always uses Veo 3.1 (no change).
   */
  async generateVideo({ prompt, model = 'veo-3.1-generate-preview', referenceImage }: { prompt: string; model?: string; referenceImage?: string }): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const requestBody: any = { prompt: { text: prompt } };

        if (referenceImage) {
          const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, '');
          requestBody.image = { image_bytes: base64Data };
        }

        const predictUrl = `${this.baseUrl}/models/${model}:predictVideo?key=${this.apiKey}`;
        const res = await fetch(predictUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Veo API error: ${res.status} ${errText}`);
        }

        const operationData = await res.json() as any;
        if (!operationData.name) {
          throw new Error('Veo API did not return an operation name');
        }

        const pollUrl = `${this.baseUrl}/${operationData.name}?key=${this.apiKey}`;
        const pollIntervalMs = 10_000;
        const maxPollAttempts = 180; // 30 minutes

        for (let poll = 0; poll < maxPollAttempts; poll++) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          const pollRes = await fetch(pollUrl);
          const pollData = await pollRes.json() as any;

          if (pollData.done) {
            if (pollData.error) {
              throw new Error(`Video generation failed: ${pollData.error.message}`);
            }
            const videoUri = pollData.response?.generatedVideos?.[0]?.video?.uri;
            if (!videoUri) {
              throw new Error('No video URI found in completed operation');
            }
            return videoUri;
          }
        }

        throw new Error('Video generation timed out after 30 minutes');

      } catch (e: any) {
        lastError = e;
        if (attempt < maxRetries) {
          const backoffMs = 5000 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError ?? new Error('Video generation failed after all retries');
  }
}
