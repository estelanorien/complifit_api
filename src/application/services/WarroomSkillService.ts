/**
 * WarroomSkillService — Reads, caches, and composes warroom expert skills.
 *
 * Skills are markdown-based agent definitions from the warroom project.
 * Each skill provides expert procedures/workflows that get prepended as
 * system prompts to AI tasks via the AIRouter config.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  domain: string;
  source: string;
  wordCount: number;
  sections: string[];
}

interface SkillRegistryFile {
  name: string;
  version: string;
  skills_count: number;
  domains: Array<{ id: string; label: string; count: number }>;
  skills: Array<{
    name: string;
    description: string;
    domain: string;
    source: string;
    word_count: number;
    sections: string[];
  }>;
}

export interface SkillRegistry {
  domains: Array<{ id: string; label: string; count: number }>;
  skills: SkillEntry[];
}

// Domain display labels
const DOMAIN_LABELS: Record<string, string> = {
  'security': 'Security',
  'devops': 'DevOps',
  'engineering': 'Engineering',
  'data': 'Data',
  'research': 'Research',
  'testing': 'Testing',
  'ai-ml': 'AI/ML',
  'ops': 'Operations',
  'marketing': 'Marketing',
  'business': 'Business',
};

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

class WarroomSkillServiceImpl {
  private rootPath: string;
  private registry: SkillRegistry = { domains: [], skills: [] };
  private contentCache = new Map<string, string>();
  private readonly MAX_CACHE = 30;
  private initialized = false;

  constructor(warroomPath?: string) {
    this.rootPath = warroomPath
      ? resolve(warroomPath)
      : resolve(process.cwd(), '..', 'warroom');
  }

  /**
   * Initialize by reading registry.json. Safe to call multiple times.
   */
  private init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const registryPath = join(this.rootPath, 'registry.json');
    if (!existsSync(registryPath)) {
      logger.warn(`[Warroom] registry.json not found at ${registryPath} — skills unavailable`);
      return;
    }

    try {
      const raw = readFileSync(registryPath, 'utf-8');
      const data: SkillRegistryFile = JSON.parse(raw);

      this.registry = {
        domains: data.domains || [],
        skills: (data.skills || []).map(s => ({
          name: s.name,
          description: s.description,
          domain: s.domain,
          source: s.source,
          wordCount: s.word_count,
          sections: s.sections,
        })),
      };

      logger.info(`[Warroom] Loaded ${this.registry.skills.length} skills from ${this.registry.domains.length} domains`);
    } catch (e: any) {
      logger.error(`[Warroom] Failed to load registry: ${e.message}`);
    }
  }

  /**
   * Get the full skill registry (metadata only, no content bodies).
   */
  getRegistry(): SkillRegistry {
    this.init();
    return this.registry;
  }

  /**
   * Get a single skill's content body (strips YAML frontmatter).
   * Cached in memory (LRU, max 30 entries).
   */
  getSkillContent(skillName: string): string | null {
    this.init();

    // Check cache — promote to most-recent (LRU)
    if (this.contentCache.has(skillName)) {
      const value = this.contentCache.get(skillName)!;
      this.contentCache.delete(skillName);
      this.contentCache.set(skillName, value);
      return value;
    }

    // Find skill in registry
    const skill = this.registry.skills.find(s => s.name === skillName);
    if (!skill) {
      logger.warn(`[Warroom] Skill not found: ${skillName}`);
      return null;
    }

    // Build path: source is "./domain/skill-name"
    const skillPath = join(this.rootPath, skill.domain, skill.name, 'SKILL.md');
    if (!existsSync(skillPath)) {
      logger.warn(`[Warroom] SKILL.md not found: ${skillPath}`);
      return null;
    }

    try {
      const raw = readFileSync(skillPath, 'utf-8');
      const body = this.stripFrontmatter(raw);

      // LRU eviction
      if (this.contentCache.size >= this.MAX_CACHE) {
        const firstKey = this.contentCache.keys().next().value;
        if (firstKey) this.contentCache.delete(firstKey);
      }
      this.contentCache.set(skillName, body);

      return body;
    } catch (e: any) {
      logger.error(`[Warroom] Failed to read skill ${skillName}: ${e.message}`);
      return null;
    }
  }

  /**
   * Compose a system prompt from multiple skills.
   * Returns empty string if no valid skills found.
   */
  composePrompt(skillNames: string[]): string {
    if (!skillNames || skillNames.length === 0) return '';

    const parts: string[] = [];
    for (const name of skillNames) {
      const content = this.getSkillContent(name);
      if (content) {
        const domainLabel = this.getSkillDomainLabel(name);
        parts.push(
          `${'='.repeat(60)}\n` +
          `SKILL: ${name} (${domainLabel})\n` +
          `${'='.repeat(60)}\n\n` +
          content
        );
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Search skills by substring match on name, description, domain.
   */
  searchSkills(query: string): SkillEntry[] {
    this.init();
    const q = query.toLowerCase();

    const scored: Array<{ score: number; skill: SkillEntry }> = [];
    for (const skill of this.registry.skills) {
      let score = 0;
      if (skill.name.toLowerCase().includes(q)) score += 3;
      if (skill.description.toLowerCase().includes(q)) score += 2;
      if (skill.domain.toLowerCase().includes(q)) score += 1;
      for (const section of skill.sections) {
        if (section.toLowerCase().includes(q)) { score += 1; break; }
      }
      if (score > 0) scored.push({ score, skill });
    }

    scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
    return scored.map(s => s.skill);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private stripFrontmatter(text: string): string {
    const match = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)/);
    return match ? match[1].trim() : text.trim();
  }

  private getSkillDomainLabel(skillName: string): string {
    const skill = this.registry.skills.find(s => s.name === skillName);
    if (!skill) return 'Unknown';
    return DOMAIN_LABELS[skill.domain] || skill.domain;
  }
}

// Lazy singleton — initialized on first access
let _instance: WarroomSkillServiceImpl | null = null;

export function getWarroomSkillService(): WarroomSkillServiceImpl {
  if (!_instance) {
    _instance = new WarroomSkillServiceImpl(env.warroomPath);
  }
  return _instance;
}

export const warroomSkillService = getWarroomSkillService();
