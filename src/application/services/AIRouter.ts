/**
 * AIRouter — Central model routing & pricing for cost-optimized AI calls.
 *
 * Routes each AI task to the optimal provider + model:
 *   TIER 1  Claude Opus 4.6     — Complex coordinated generation (smart plan only)
 *   TIER 2  Claude Sonnet 4.5   — Smart reasoning (coaching, guardian, parsing, body comp)
 *   TIER 3  Claude Haiku 4.5    — Simple text (tips, lists, plans, verification)
 *   TIER 4  Gemini Flash         — Cheapest (translation, food logs, meta)
 *   IMAGE   Gemini Imagen        — All image generation
 *   VIDEO   Veo 3.1              — All video generation
 *   TTS     Google Cloud TTS     — All voiceovers
 *
 * Supports runtime overrides via admin panel (stored in cached_assets DB table).
 * Warroom skills can be attached as system prompts per task type.
 *
 * MODEL_PRICING is the single source of truth for cost calculations.
 * Last verified: 2026-02-09
 * Sources:
 *   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   Google:    https://ai.google.dev/gemini-api/docs/pricing
 */

import { env } from '../../config/env.js';
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Task types
// ────────────────────────────────────────────────────────────────────────────

export type AITaskType =
  // Tier 1 — Opus (complex coordinated generation)
  | 'smart_plan'
  // Tier 2 — Sonnet (reasoning + empathy)
  | 'rehab_plan'
  | 'body_composition'
  | 'coaching_feedback'
  | 'coach_chat'
  | 'guardian_analysis'
  | 'exercise_details'
  | 'recipe_suggestion'
  | 'identity_verification'
  | 'custom_program_parse'
  // Tier 3 — Haiku (fast + cheap)
  | 'nutrition_plan'
  | 'training_plan'
  | 'workout_verification'
  | 'safety_validation'
  | 'guardian_apply'
  | 'dietary_tips'
  | 'shopping_list'
  | 'culinary_explorer'
  // Tier 4 — Gemini Flash (cheapest)
  | 'food_log_text'
  | 'food_log_image'
  | 'menu_analysis'
  | 'clean_prompt'
  | 'translate'
  | 'canonicalize'
  | 'meta_text'
  | 'instruction_text'
  | 'generic_text'
  // Media (always Google)
  | 'image_generation'
  | 'video_generation'
  | 'tts';

export type AIProvider = 'anthropic' | 'gemini';

export interface RouteResult {
  provider: AIProvider;
  model: string;
  tier: 1 | 2 | 3 | 4;
  maxOutputTokens?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Dynamic config types (stored in cached_assets as JSON)
// ────────────────────────────────────────────────────────────────────────────

export interface TaskOverride {
  tier: 1 | 2 | 3 | 4;
  model?: string;
  maxOutputTokens?: number;
  skillIds?: string[];
}

export interface AIRoutingConfig {
  version: number;
  overrides: Record<string, TaskOverride>;
  updatedAt?: string;
  updatedBy?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Model pricing — SINGLE SOURCE OF TRUTH
// Last verified: 2026-02-09
// ────────────────────────────────────────────────────────────────────────────

export interface ModelPricing {
  model: string;
  provider: AIProvider;
  inputPer1M: number;
  outputPer1M: number;
  perImageCall?: number;
  perVideoSec?: number;
  perTtsChar?: number;
  label: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':               { model: 'claude-opus-4-6',               provider: 'anthropic', inputPer1M: 5.00,  outputPer1M: 25.00, label: 'Claude Opus 4.6' },
  'claude-sonnet-4-5-20250929':    { model: 'claude-sonnet-4-5-20250929',    provider: 'anthropic', inputPer1M: 3.00,  outputPer1M: 15.00, label: 'Claude Sonnet 4.5' },
  'claude-haiku-4-5-20251001':     { model: 'claude-haiku-4-5-20251001',     provider: 'anthropic', inputPer1M: 1.00,  outputPer1M: 5.00,  label: 'Claude Haiku 4.5' },
  'models/gemini-2.0-flash':       { model: 'models/gemini-2.0-flash',       provider: 'gemini',    inputPer1M: 0.10,  outputPer1M: 0.40,  label: 'Gemini 2.0 Flash' },
  'models/gemini-3-flash-preview': { model: 'models/gemini-3-flash-preview', provider: 'gemini',    inputPer1M: 0.50,  outputPer1M: 3.00,  label: 'Gemini 3 Flash' },
  'models/gemini-2.5-flash-image': { model: 'models/gemini-2.5-flash-image', provider: 'gemini',    inputPer1M: 0,     outputPer1M: 0,     perImageCall: 0.04,  label: 'Gemini Imagen' },
  'veo-3.1-generate-preview':      { model: 'veo-3.1-generate-preview',      provider: 'gemini',    inputPer1M: 0,     outputPer1M: 0,     perVideoSec: 0.006,  label: 'Veo 3.1' },
  'google-cloud-tts':              { model: 'google-cloud-tts',              provider: 'gemini',    inputPer1M: 0,     outputPer1M: 0,     perTtsChar: 16.00,   label: 'Google TTS' },
};

// ────────────────────────────────────────────────────────────────────────────
// Task cost profiles — estimated tokens per call (for cost calculator)
// ────────────────────────────────────────────────────────────────────────────

export interface TaskCostProfile {
  avgInputTokens: number;
  avgOutputTokens: number;
  description: string;
  category: 'plan' | 'analysis' | 'chat' | 'utility' | 'media' | 'safety';
  avgCallsPerUser?: string;
}

export const TASK_COST_PROFILES: Record<string, TaskCostProfile> = {
  smart_plan:            { avgInputTokens: 3500, avgOutputTokens: 4000, description: 'Coordinated training + nutrition plan', category: 'plan',     avgCallsPerUser: '1/week' },
  nutrition_plan:        { avgInputTokens: 1300, avgOutputTokens: 4000, description: 'Nutrition plan generation',             category: 'plan',     avgCallsPerUser: '1/week' },
  training_plan:         { avgInputTokens: 1200, avgOutputTokens: 3000, description: 'Training plan generation',              category: 'plan',     avgCallsPerUser: '1/week' },
  rehab_plan:            { avgInputTokens: 1500, avgOutputTokens: 3500, description: 'Rehabilitation program',                category: 'plan',     avgCallsPerUser: '0.1/week' },
  food_log_text:         { avgInputTokens: 800,  avgOutputTokens: 200,  description: 'Text-only food logging',                category: 'analysis', avgCallsPerUser: '14/week' },
  food_log_image:        { avgInputTokens: 1800, avgOutputTokens: 200,  description: 'Photo food logging',                    category: 'analysis', avgCallsPerUser: '7/week' },
  body_composition:      { avgInputTokens: 2000, avgOutputTokens: 500,  description: 'Body composition analysis',             category: 'analysis', avgCallsPerUser: '0.5/week' },
  workout_verification:  { avgInputTokens: 1500, avgOutputTokens: 200,  description: 'Workout selfie verification',           category: 'analysis', avgCallsPerUser: '3/week' },
  coaching_feedback:     { avgInputTokens: 1500, avgOutputTokens: 800,  description: 'Expert coaching response',              category: 'chat',     avgCallsPerUser: '2/week' },
  safety_validation:     { avgInputTokens: 800,  avgOutputTokens: 200,  description: 'Content safety check',                  category: 'safety',   avgCallsPerUser: '2/week' },
  coach_chat:            { avgInputTokens: 1500, avgOutputTokens: 500,  description: 'Coach chat message',                    category: 'chat',     avgCallsPerUser: '10/week' },
  guardian_analysis:     { avgInputTokens: 1200, avgOutputTokens: 600,  description: 'Guardian/parent analysis',              category: 'analysis', avgCallsPerUser: '0.5/week' },
  menu_analysis:         { avgInputTokens: 2000, avgOutputTokens: 800,  description: 'Restaurant menu analysis',              category: 'analysis', avgCallsPerUser: '1/week' },
  exercise_details:      { avgInputTokens: 600,  avgOutputTokens: 400,  description: 'Exercise instruction details',          category: 'utility',  avgCallsPerUser: '5/week' },
  recipe_suggestion:     { avgInputTokens: 700,  avgOutputTokens: 600,  description: 'Recipe recommendations',                category: 'utility',  avgCallsPerUser: '2/week' },
  identity_verification: { avgInputTokens: 800,  avgOutputTokens: 200,  description: 'User identity verification',            category: 'safety',   avgCallsPerUser: '0.1/week' },
  custom_program_parse:  { avgInputTokens: 2000, avgOutputTokens: 1500, description: 'Parse custom workout program',          category: 'utility',  avgCallsPerUser: '0.2/week' },
  guardian_apply:        { avgInputTokens: 600,  avgOutputTokens: 300,  description: 'Apply guardian rules',                  category: 'safety',   avgCallsPerUser: '1/week' },
  dietary_tips:          { avgInputTokens: 500,  avgOutputTokens: 300,  description: 'Quick diet tips',                       category: 'utility',  avgCallsPerUser: '2/week' },
  shopping_list:         { avgInputTokens: 800,  avgOutputTokens: 500,  description: 'Shopping list generation',              category: 'utility',  avgCallsPerUser: '1/week' },
  culinary_explorer:     { avgInputTokens: 600,  avgOutputTokens: 500,  description: 'Recipe exploration',                    category: 'utility',  avgCallsPerUser: '1/week' },
  clean_prompt:          { avgInputTokens: 300,  avgOutputTokens: 200,  description: 'Prompt sanitization',                   category: 'utility',  avgCallsPerUser: '5/week' },
  translate:             { avgInputTokens: 400,  avgOutputTokens: 300,  description: 'Text translation',                      category: 'utility',  avgCallsPerUser: '10/week' },
  canonicalize:          { avgInputTokens: 300,  avgOutputTokens: 200,  description: 'Data canonicalization',                 category: 'utility',  avgCallsPerUser: '3/week' },
  meta_text:             { avgInputTokens: 400,  avgOutputTokens: 300,  description: 'Meta text generation',                  category: 'utility',  avgCallsPerUser: '2/week' },
  instruction_text:      { avgInputTokens: 500,  avgOutputTokens: 400,  description: 'Instruction text generation',           category: 'utility',  avgCallsPerUser: '3/week' },
  generic_text:          { avgInputTokens: 500,  avgOutputTokens: 400,  description: 'Generic text generation',               category: 'utility',  avgCallsPerUser: '2/week' },
  image_generation:      { avgInputTokens: 0,    avgOutputTokens: 0,    description: 'Image generation (Imagen)',              category: 'media',    avgCallsPerUser: '0/week' },
  video_generation:      { avgInputTokens: 0,    avgOutputTokens: 0,    description: 'Video generation (Veo)',                 category: 'media',    avgCallsPerUser: '0/week' },
  tts:                   { avgInputTokens: 0,    avgOutputTokens: 0,    description: 'Text-to-speech',                         category: 'media',    avgCallsPerUser: '0/week' },
};

// ────────────────────────────────────────────────────────────────────────────
// Hardcoded defaults (routing table)
// ────────────────────────────────────────────────────────────────────────────

const TIER1_TASKS: Set<AITaskType> = new Set([
  'smart_plan'
]);

const TIER2_TASKS: Set<AITaskType> = new Set([
  'rehab_plan', 'body_composition', 'coaching_feedback',
  'coach_chat', 'guardian_analysis', 'exercise_details',
  'recipe_suggestion', 'identity_verification', 'custom_program_parse'
]);

const TIER3_TASKS: Set<AITaskType> = new Set([
  'nutrition_plan', 'training_plan', 'workout_verification', 'safety_validation',
  'guardian_apply', 'dietary_tips', 'shopping_list', 'culinary_explorer'
]);

// Tasks that use Gemini 3 Flash Preview (better vision) instead of 2.0 Flash
const GEMINI3_FLASH_TASKS: Set<AITaskType> = new Set([
  'food_log_image', 'menu_analysis'
]);

// Everything else → Tier 4 (Gemini Flash)

const MEDIA_TASKS: Set<AITaskType> = new Set([
  'image_generation', 'video_generation', 'tts'
]);

// ────────────────────────────────────────────────────────────────────────────
// Models
// ────────────────────────────────────────────────────────────────────────────

const CLAUDE_OPUS    = 'claude-opus-4-6';
const CLAUDE_SONNET  = 'claude-sonnet-4-5-20250929';
const CLAUDE_HAIKU   = 'claude-haiku-4-5-20251001';
const GEMINI_FLASH   = 'models/gemini-2.0-flash';
const GEMINI_3_FLASH = 'models/gemini-3-flash-preview';

const TIER_MODELS: Record<number, string> = {
  1: CLAUDE_OPUS,
  2: CLAUDE_SONNET,
  3: CLAUDE_HAIKU,
  4: GEMINI_FLASH,
};

const TIER_MAX_TOKENS: Record<number, number> = {
  1: 16384,
  2: 8192,
  3: 4096,
  4: 4096,
};

// ────────────────────────────────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────────────────────────────────

class AIRouterService {
  private claudeAvailable: boolean;

  // Dynamic config cache
  private configCache: AIRoutingConfig | null = null;
  private configCacheTime = 0;
  private configLoadPromise: Promise<void> | null = null;
  private readonly CONFIG_TTL_MS = 30_000; // 30 seconds

  constructor() {
    this.claudeAvailable = !!env.anthropicApiKey;
    if (!this.claudeAvailable) {
      console.warn('[AIRouter] ANTHROPIC_API_KEY not set — all text tasks will fall back to Gemini');
    }
  }

  /**
   * Route a task to the optimal provider + model.
   * Checks admin overrides first, then falls back to hardcoded defaults.
   * Gemini fallback if Claude unavailable.
   */
  route(task: AITaskType): RouteResult {
    // Media tasks always go to Google — not overridable
    if (task === 'image_generation') {
      return { provider: 'gemini', model: 'models/gemini-2.5-flash-image', tier: 4 };
    }
    if (task === 'video_generation') {
      return { provider: 'gemini', model: 'veo-3.1-generate-preview', tier: 4 };
    }
    if (task === 'tts') {
      return { provider: 'gemini', model: 'google-cloud-tts', tier: 4 };
    }

    // Check admin overrides (non-blocking — uses cached config)
    const override = this.getOverride(task);
    if (override) {
      const tier = override.tier;
      if (tier <= 3 && this.claudeAvailable) {
        return {
          provider: 'anthropic',
          model: override.model || TIER_MODELS[tier] || CLAUDE_SONNET,
          tier: tier as 1 | 2 | 3,
          maxOutputTokens: override.maxOutputTokens || TIER_MAX_TOKENS[tier],
        };
      }
      if (tier === 4) {
        // Use Gemini 3 Flash for vision tasks, 2.0 Flash for text
        const model = override.model || (GEMINI3_FLASH_TASKS.has(task) ? GEMINI_3_FLASH : GEMINI_FLASH);
        return { provider: 'gemini', model, tier: 4, maxOutputTokens: override.maxOutputTokens || 4096 };
      }
    }

    // Hardcoded defaults
    if (this.claudeAvailable) {
      if (TIER1_TASKS.has(task)) {
        return { provider: 'anthropic', model: CLAUDE_OPUS, tier: 1, maxOutputTokens: 16384 };
      }
      if (TIER2_TASKS.has(task)) {
        return { provider: 'anthropic', model: CLAUDE_SONNET, tier: 2, maxOutputTokens: 8192 };
      }
      if (TIER3_TASKS.has(task)) {
        return { provider: 'anthropic', model: CLAUDE_HAIKU, tier: 3, maxOutputTokens: 4096 };
      }
    }

    // Tier 4 — use Gemini 3 Flash for vision tasks, 2.0 Flash for text
    if (GEMINI3_FLASH_TASKS.has(task)) {
      return { provider: 'gemini', model: GEMINI_3_FLASH, tier: 4, maxOutputTokens: 4096 };
    }
    return { provider: 'gemini', model: GEMINI_FLASH, tier: 4, maxOutputTokens: 4096 };
  }

  /**
   * Get warroom skill IDs attached to a task (from admin config).
   */
  getSkillIds(task: AITaskType): string[] {
    const override = this.getOverride(task);
    return override?.skillIds || [];
  }

  /**
   * Get the hardcoded default routing table for admin UI reference.
   */
  getDefaultRoutingTable(): Record<string, { tier: number; model: string; maxOutputTokens: number }> {
    const table: Record<string, { tier: number; model: string; maxOutputTokens: number }> = {};

    for (const task of TIER1_TASKS) {
      table[task] = { tier: 1, model: CLAUDE_OPUS, maxOutputTokens: 16384 };
    }
    for (const task of TIER2_TASKS) {
      table[task] = { tier: 2, model: CLAUDE_SONNET, maxOutputTokens: 8192 };
    }
    for (const task of TIER3_TASKS) {
      table[task] = { tier: 3, model: CLAUDE_HAIKU, maxOutputTokens: 4096 };
    }

    // Tier 4 tasks — differentiate Gemini 3 Flash for vision tasks
    const tier4Tasks: AITaskType[] = ['food_log_text', 'clean_prompt', 'translate', 'canonicalize', 'meta_text', 'instruction_text', 'generic_text'];
    for (const task of tier4Tasks) {
      table[task] = { tier: 4, model: GEMINI_FLASH, maxOutputTokens: 4096 };
    }

    // Tier 4 — Gemini 3 Flash (vision-capable)
    for (const task of GEMINI3_FLASH_TASKS) {
      table[task] = { tier: 4, model: GEMINI_3_FLASH, maxOutputTokens: 4096 };
    }

    // Media tasks (locked)
    table['image_generation'] = { tier: 4, model: 'models/gemini-2.5-flash-image', maxOutputTokens: 0 };
    table['video_generation'] = { tier: 4, model: 'veo-3.1-generate-preview', maxOutputTokens: 0 };
    table['tts'] = { tier: 4, model: 'google-cloud-tts', maxOutputTokens: 0 };

    return table;
  }

  /**
   * Get model pricing table.
   */
  getPricing(): Record<string, ModelPricing> {
    return MODEL_PRICING;
  }

  /**
   * Get task cost profiles.
   */
  getTaskProfiles(): Record<string, TaskCostProfile> {
    return TASK_COST_PROFILES;
  }

  /**
   * Estimate cost per call for a task using current routing.
   */
  estimateTaskCost(task: AITaskType): { inputCost: number; outputCost: number; totalCost: number } {
    const routeResult = this.route(task);
    const profile = TASK_COST_PROFILES[task];
    const pricing = MODEL_PRICING[routeResult.model];

    if (!profile || !pricing) {
      return { inputCost: 0, outputCost: 0, totalCost: 0 };
    }

    if (pricing.perImageCall) return { inputCost: 0, outputCost: 0, totalCost: pricing.perImageCall };
    if (pricing.perVideoSec) return { inputCost: 0, outputCost: 0, totalCost: pricing.perVideoSec * 8 };

    const inputCost = (profile.avgInputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (profile.avgOutputTokens / 1_000_000) * pricing.outputPer1M;
    return { inputCost, outputCost, totalCost: inputCost + outputCost };
  }

  /**
   * Check if Claude is available.
   */
  isClaudeAvailable(): boolean {
    return this.claudeAvailable;
  }

  /**
   * Force Gemini fallback.
   */
  geminiOnly(_task: AITaskType): RouteResult {
    return { provider: 'gemini', model: GEMINI_FLASH, tier: 4, maxOutputTokens: 4096 };
  }

  /**
   * Invalidate config cache and eagerly reload (called after admin saves).
   */
  invalidateConfig(): void {
    this.configCacheTime = 0;
    this.configCache = null;
    this.configLoadPromise = null;
    // Eagerly reload so the next route() call sees fresh data
    this.refreshConfigIfStale();
  }

  /**
   * Load config from DB (for admin GET endpoint).
   */
  async loadConfig(): Promise<AIRoutingConfig> {
    try {
      const res = await pool.query(
        `SELECT value FROM cached_assets WHERE key = 'ai_routing_config'`
      );
      if (res.rows.length > 0 && res.rows[0].value) {
        return JSON.parse(res.rows[0].value);
      }
    } catch (e: any) {
      logger.warn(`[AIRouter] Failed to load config from DB: ${e.message}`);
    }
    return { version: 1, overrides: {} };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────────────────────────────

  private getOverride(task: AITaskType): TaskOverride | undefined {
    // Don't allow overriding media tasks
    if (MEDIA_TASKS.has(task)) return undefined;

    this.refreshConfigIfStale();
    return this.configCache?.overrides[task];
  }

  private refreshConfigIfStale(): void {
    if (Date.now() - this.configCacheTime < this.CONFIG_TTL_MS) return;
    if (this.configLoadPromise) return; // already loading

    this.configLoadPromise = this.loadConfig()
      .then(config => {
        this.configCache = config;
        this.configCacheTime = Date.now();
      })
      .catch(e => {
        logger.warn(`[AIRouter] Config refresh failed: ${e.message}`);
      })
      .finally(() => {
        this.configLoadPromise = null;
      });
  }
}

export const aiRouter = new AIRouterService();
