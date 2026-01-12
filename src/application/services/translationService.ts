import { pool } from '../../infra/db/pool';
import { AiService } from './aiService';

const aiService = new AiService();

export class TranslationService {
    /**
     * Translates a single string and caches it.
     */
    async translateText(text: string, lang: string, category?: string): Promise<string> {
        if (!text || lang === 'en') return text;

        const trimmedText = text.trim();
        if (!trimmedText) return text;

        try {
            // 1. Check if we have a match in the translation cache
            const { rows } = await pool.query(
                'SELECT translated_text FROM content_translations WHERE original_text = $1 AND language = $2',
                [trimmedText, lang]
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
                'INSERT INTO content_translations (original_text, language, translated_text, category) VALUES ($1, $2, $3, $4) ON CONFLICT (original_text, language) DO NOTHING',
                [trimmedText, lang, cleanTranslated, category || 'general']
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
}

export const translationService = new TranslationService();
