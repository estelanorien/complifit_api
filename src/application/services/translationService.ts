import { pool } from '../../infra/db/pool.js';
import { AiService } from './aiService.js';

const aiService = new AiService();

export class TranslationService {
    private getContentHash(text: string): string {
        if (!text) return '0';
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = (hash * 33) ^ text.charCodeAt(i);
        }
        return (hash >>> 0).toString(36);
    }

    /**
     * Translates a single string and caches it.
     */
    async translateText(text: string, lang: string, category?: string): Promise<string> {
        if (!text || lang === 'en') return text;

        const trimmedText = text.trim();
        if (!trimmedText) return text;

        try {
            // 1. Check if we have a match in the translation cache
            const contentHash = this.getContentHash(trimmedText);
            const { rows } = await pool.query(
                'SELECT translated_text FROM content_translations WHERE (content_hash = $1 OR original_text = $2) AND language = $3 LIMIT 1',
                [contentHash, trimmedText, lang]
            );

            if (rows.length > 0) {
                return rows[0].translated_text;
            }

            // 2. Not in cache, use AI to translate
            // We use a specific instruction to ensure only the translation is returned
            const prompt = `You are a professional translator. Translate this text into the following language: ${lang}.
Return ONLY the translated text. Do not include any explanations, notes, or labels.
Text to translate:
${trimmedText}`;

            const { text: translated } = await aiService.generateText({
                prompt,
                model: 'models/gemini-2.0-flash' // Fast and effective for translations
            });

            const cleanTranslated = translated.trim();

            if (!cleanTranslated) return trimmedText;

            // 3. Persist to cache (fire and forget to not block response)
            pool.query(
                'INSERT INTO content_translations (original_text, language, translated_text, category, content_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (original_text, language) DO NOTHING',
                [trimmedText, lang, cleanTranslated, category || 'general', contentHash]
            ).catch(err => {
                // Log to stderr for cloud environment visibility
                process.stderr.write(`[TranslationService] Caching failed: ${err.message}\n`);
            });

            return cleanTranslated;
        } catch (e: any) {
            process.stderr.write(`[TranslationService] AI translation error: ${e.message}\n`);
            return trimmedText; // Fallback to English
        }
    }

    /**
     * Batch translate a list of strings (e.g. ingredients or instructions).
     */
    async translateList(items: string[], lang: string, category?: string): Promise<string[]> {
        if (!items || items.length === 0 || lang === 'en') return items;

        // Process in parallel for speed
        return Promise.all(items.map(item => this.translateText(item, lang, category)));
    }

    /**
     * Triggers background translation for a text or list of texts into all supported languages.
     * Fires and forgets (does not await).
     */
    preTranslate(content: string | string[], category?: string): void {
        const targetLangs = ['fr', 'es', 'tr', 'ar', 'zh'];
        const items = Array.isArray(content) ? content : [content];

        for (const lang of targetLangs) {
            for (const text of items) {
                // translateText handles caching automatically
                this.translateText(text, lang, category).catch(() => { });
            }
        }
    }
}

export const translationService = new TranslationService();
