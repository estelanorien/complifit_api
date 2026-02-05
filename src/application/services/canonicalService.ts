
import { AiService } from './aiService.js';
import { pool } from '../../infra/db/pool.js';
import { normalizeToMovementId } from './normalization.js';

const aiService = new AiService();

/** Known non-English exercise names -> canonical English name (for merging cross-language variants without LLM). */
const EXERCISE_NAME_ALIASES: Record<string, string> = {
    'Yoga Akışı': 'Yoga Flow',
    'Yoga (akış)': 'Yoga Flow',
    'Yoga (esneme)': 'Yoga Stretching',
    'Çeviklik Merdiveni': 'Agility Ladder',
    'Şınav': 'Push-Ups',
    'Barfiks': 'Pull-ups',
};

export interface CanonicalIdentity {
    canonicalId: string;
    originalName: string;
    language: string;
}

export class CanonicalService {
    /**
     * Maps a localized name to a canonical English ID.
     * Uses LLM for the translation/mapping and caches the result.
     * Set forceLlm=true to skip cache and always use LLM (for re-merging cross-language variants).
     */
    async getCanonicalId(name: string, type: 'meal' | 'exercise', forceLlm = false): Promise<CanonicalIdentity> {
        if (!name) return { canonicalId: 'unknown', originalName: '', language: 'en' };

        const trimmed = name.trim();

        if (!forceLlm) {
            // 1. Check if we already have a mapping for this EXACT string
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

        if (type === 'exercise' && EXERCISE_NAME_ALIASES[trimmed]) {
            const englishName = EXERCISE_NAME_ALIASES[trimmed];
            return {
                canonicalId: `movement_${this.simpleNormalize(englishName)}`,
                originalName: trimmed,
                language: 'tr'
            };
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

        const prefix = type === 'meal' ? 'meal' : 'movement';
        const fallback = (): CanonicalIdentity => ({
            canonicalId: `${prefix}_${this.simpleNormalize(trimmed)}`,
            originalName: trimmed,
            language: 'unknown'
        });

        let text: string = '';
        const maxRetries = 3;
        const retryDelayMs = 5000;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await aiService.generateText({
                    prompt,
                    model: 'models/gemini-3-flash-preview'
                });
                text = res.text;
                break;
            } catch (e: any) {
                const isRetryable = e?.message?.includes('503') || e?.message?.includes('overloaded') || e?.message?.includes('UNAVAILABLE');
                if (isRetryable && attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, retryDelayMs));
                    continue;
                }
                if (type === 'exercise' && EXERCISE_NAME_ALIASES[trimmed]) {
                    const englishName = EXERCISE_NAME_ALIASES[trimmed];
                    return { canonicalId: `movement_${this.simpleNormalize(englishName)}`, originalName: trimmed, language: 'tr' };
                }
                return fallback();
            }
        }

        try {
            const jsonStr = (text as string)
                .replace(/^[\s\S]*?```(?:json)?\s*/i, '')
                .replace(/\s*```[\s\S]*$/i, '')
                .trim();
            const result = JSON.parse(jsonStr);
            const englishName = result.englishName || trimmed;
            const lang = result.languageCode || 'unknown';

            const normalized = this.simpleNormalize(englishName);
            const canonicalId = `${prefix}_${normalized}`;

            return {
                canonicalId,
                originalName: trimmed,
                language: lang
            };
        } catch {
            if (type === 'exercise' && EXERCISE_NAME_ALIASES[trimmed]) {
                const englishName = EXERCISE_NAME_ALIASES[trimmed];
                return { canonicalId: `movement_${this.simpleNormalize(englishName)}`, originalName: trimmed, language: 'tr' };
            }
            return fallback();
        }
    }

    /**
     * Get canonical identity without calling LLM. Uses DB cache only, then
     * fallback to prefix + simpleNormalize(name). Use when STANDARDIZE_NO_LLM=1.
     */
    async getCanonicalIdNoLlm(name: string, type: 'meal' | 'exercise'): Promise<CanonicalIdentity> {
        if (!name) return { canonicalId: 'unknown', originalName: '', language: 'en' };
        const trimmed = name.trim();
        const { rows: existing } = await pool.query(
            `SELECT movement_id, language FROM cached_asset_meta WHERE original_name = $1 LIMIT 1`,
            [trimmed]
        );
        if (existing.length > 0) {
            return {
                canonicalId: existing[0].movement_id,
                originalName: trimmed,
                language: existing[0].language || 'en'
            };
        }
        if (type === 'exercise' && EXERCISE_NAME_ALIASES[trimmed]) {
            const englishName = EXERCISE_NAME_ALIASES[trimmed];
            return {
                canonicalId: `movement_${this.simpleNormalize(englishName)}`,
                originalName: trimmed,
                language: 'tr'
            };
        }
        const prefix = type === 'meal' ? 'meal' : 'movement';
        return {
            canonicalId: `${prefix}_${this.simpleNormalize(trimmed)}`,
            originalName: trimmed,
            language: 'unknown'
        };
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
