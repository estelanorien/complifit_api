
import { AiService } from './aiService.js';
import { pool } from '../../infra/db/pool.js';
import { normalizeToMovementId } from './normalization.js';

const aiService = new AiService();

export interface CanonicalIdentity {
    canonicalId: string;
    originalName: string;
    language: string;
}

export class CanonicalService {
    /**
     * Maps a localized name to a canonical English ID without using LLM.
     * Simple normalization-based approach for fast lookups.
     */
    async getCanonicalIdNoLlm(name: string, type: 'meal' | 'exercise'): Promise<CanonicalIdentity> {
        if (!name) return { canonicalId: 'unknown', originalName: '', language: 'en' };
        const trimmed = name.trim();

        // Check cache first
        const { rows: existing } = await pool.query(
            `SELECT movement_id, language
             FROM cached_asset_meta
             WHERE original_name = $1
             LIMIT 1`,
            [trimmed]
        );

        if (existing.length > 0) {
            return {
                canonicalId: existing[0].movement_id,
                originalName: trimmed,
                language: existing[0].language || 'en'
            };
        }

        // Simple normalization without LLM
        const prefix = type === 'meal' ? 'meal' : 'movement';
        return {
            canonicalId: `${prefix}_${this.simpleNormalize(trimmed)}`,
            originalName: trimmed,
            language: 'unknown'
        };
    }

    /**
     * Maps a localized name to a canonical English ID.
     * Uses LLM for the translation/mapping and caches the result.
     * @param forceLlm - Skip cache and always use LLM (useful for cross-language merging)
     */
    async getCanonicalId(name: string, type: 'meal' | 'exercise', forceLlm = false): Promise<CanonicalIdentity> {
        if (!name) return { canonicalId: 'unknown', originalName: '', language: 'en' };

        const trimmed = name.trim();

        // 1. Check if we already have a mapping for this EXACT string (skip if forceLlm)
        // We look in cached_asset_meta for any group that used this original_name
        if (!forceLlm) {
            const { rows: existing } = await pool.query(
                `SELECT movement_id, language
                 FROM cached_asset_meta
                 WHERE original_name = $1
                 LIMIT 1`,
                [trimmed]
            );

            if (existing.length > 0) {
                return {
                    canonicalId: existing[0].movement_id,
                    originalName: trimmed,
                    language: existing[0].language || 'en'
                };
            }
        }

        // 2. Use LLM to get English name and detect language
        const prompt = `You are a culinary and fitness expert. Map the following ${type} name into a standardized, descriptive English name.
        Also detect the input language.
        
        Return JSON format:
        {
          "englishName": "Standardized English Name",
          "languageCode": "tr",
          "isCustom": false
        }
        
        Rules:
        - "englishName" should be concise but descriptive (e.g. "Zucchini Spaghetti with Pesto" instead of just "Kabak Spagetti").
        - "isCustom" should be true ONLY if the name is highly specific or personal (e.g. "My Grandma's Secret Soup").
        - For standard items, "isCustom" should be false.
        
        Input Name: ${trimmed}`;

        const { text } = await aiService.generateText({
            prompt,
            model: 'models/gemini-3-flash-preview'
        });

        try {
            const result = JSON.parse(text);
            const englishName = result.englishName || trimmed;
            const lang = result.languageCode || 'unknown';

            // Normalize the English name to create the Canonical ID
            // prefix_normalized_name
            const prefix = type === 'meal' ? 'meal' : 'movement';
            const normalized = this.simpleNormalize(englishName);
            const canonicalId = `${prefix}_${normalized}`;

            return {
                canonicalId,
                originalName: trimmed,
                language: lang
            };
        } catch (e) {
            console.error("[CanonicalService] Parse Error:", e);
            // Fallback: simple normalization of the input name
            const prefix = type === 'meal' ? 'meal' : 'movement';
            return {
                canonicalId: `${prefix}_${this.simpleNormalize(trimmed)}`,
                originalName: trimmed,
                language: 'unknown'
            };
        }
    }

    private simpleNormalize(str: string): string {
        return str.toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(' ')
            .filter(w => w.length > 0)
            .join('_');
    }
}

export const canonicalService = new CanonicalService();
