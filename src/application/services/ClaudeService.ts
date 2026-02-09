/**
 * ClaudeService — Anthropic SDK wrapper for Claude API calls.
 *
 * Provides: generateText(), generateStructuredOutput(), analyzeImage()
 * Handles: retry with exponential backoff, structured JSON output, Gemini fallback.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ClaudeTextRequest {
  systemPrompt?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ClaudeStructuredRequest<T> {
  systemPrompt?: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** JSON schema description for the response. Claude will follow it. */
  schema?: string;
}

export interface ClaudeImageRequest {
  systemPrompt?: string;
  prompt: string;
  imageBase64: string;
  imageMimeType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ClaudeMultiImageRequest {
  systemPrompt?: string;
  prompt: string;
  images: Array<{ base64: string; mimeType?: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ClaudeChatRequest {
  systemPrompt?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

class ClaudeServiceImpl {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      if (!env.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
      }
      this.client = new Anthropic({ apiKey: env.anthropicApiKey });
    }
    return this.client;
  }

  /**
   * Generate text using Claude.
   */
  async generateText(req: ClaudeTextRequest): Promise<{ text: string }> {
    const client = this.getClient();

    const response = await this.withRetry(async () => {
      return client.messages.create({
        model: req.model || 'claude-sonnet-4-5-20250929',
        max_tokens: req.maxTokens || 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: [{ role: 'user', content: req.prompt }]
      });
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    return { text };
  }

  /**
   * Generate structured JSON output using Claude.
   * Uses prompt engineering + JSON extraction for reliable structured output.
   */
  async generateStructuredOutput<T = any>(req: ClaudeStructuredRequest<T>): Promise<{ data: T; raw: string }> {
    const schemaInstruction = req.schema
      ? `\n\nYou MUST return ONLY valid JSON matching this schema:\n${req.schema}\n\nReturn ONLY the JSON, no explanations, no markdown fences.`
      : '\n\nReturn ONLY valid JSON. No explanations, no markdown fences.';

    const { text } = await this.generateText({
      ...req,
      prompt: req.prompt + schemaInstruction,
      temperature: req.temperature ?? 0.3  // Lower temperature for structured output
    });

    // Extract JSON from response (handle potential markdown fences)
    const jsonStr = this.extractJson(text);
    const data = JSON.parse(jsonStr) as T;
    return { data, raw: text };
  }

  /**
   * Analyze an image using Claude's vision capabilities.
   */
  async analyzeImage(req: ClaudeImageRequest): Promise<{ text: string }> {
    const client = this.getClient();
    const mimeType = req.imageMimeType || 'image/png';
    const base64Data = req.imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const response = await this.withRetry(async () => {
      return client.messages.create({
        model: req.model || 'claude-sonnet-4-5-20250929',
        max_tokens: req.maxTokens || 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64Data }
            },
            { type: 'text', text: req.prompt }
          ]
        }]
      });
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    return { text };
  }

  /**
   * Analyze multiple images using Claude's vision capabilities.
   */
  async analyzeMultipleImages(req: ClaudeMultiImageRequest): Promise<{ text: string }> {
    const client = this.getClient();

    const content: Anthropic.MessageCreateParams['messages'][0]['content'] = [];

    for (const img of req.images) {
      const mimeType = (img.mimeType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      const base64Data = img.base64.replace(/^data:image\/\w+;base64,/, '');
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64Data }
      });
    }

    content.push({ type: 'text', text: req.prompt });

    const response = await this.withRetry(async () => {
      return client.messages.create({
        model: req.model || 'claude-sonnet-4-5-20250929',
        max_tokens: req.maxTokens || 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: [{ role: 'user', content }]
      });
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    return { text };
  }

  /**
   * Multi-turn chat using Claude's native conversation support.
   */
  async generateChat(req: ClaudeChatRequest): Promise<{ text: string }> {
    const client = this.getClient();

    const response = await this.withRetry(async () => {
      return client.messages.create({
        model: req.model || 'claude-sonnet-4-5-20250929',
        max_tokens: req.maxTokens || 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        messages: req.messages
      });
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    return { text };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extract JSON from a response that might contain markdown fences or extra text.
   */
  private extractJson(text: string): string {
    // Try to find JSON in markdown code block
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) return fenceMatch[1].trim();

    // Try to find JSON object or array
    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) return jsonMatch[1].trim();

    // Return as-is (may already be clean JSON)
    return text.trim();
  }

  /**
   * Retry with exponential backoff for transient errors.
   */
  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastError = e;
        const isRetryable = this.isRetryableError(e);

        if (!isRetryable || attempt === maxAttempts) {
          throw e;
        }

        const delayMs = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        logger.warn(`[Claude] Attempt ${attempt}/${maxAttempts} failed (${e.message}), retrying in ${Math.round(delayMs)}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  private isRetryableError(e: any): boolean {
    if (e?.status === 429) return true; // Rate limit
    if (e?.status === 529) return true; // Overloaded
    if (e?.status >= 500) return true;  // Server error
    if (e?.message?.includes('timeout')) return true;
    if (e?.message?.includes('ECONNRESET')) return true;
    return false;
  }
}

export const claudeService = new ClaudeServiceImpl();
