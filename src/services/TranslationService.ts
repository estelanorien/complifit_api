
import { pool } from '../infra/db/pool.js';
import { generateAsset } from './AssetGenerationService.js';
import { env } from '../config/env.js';

const TARGET_LANGUAGES = ['es', 'fr', 'de', 'it', 'pt', 'ru', 'tr', 'zh', 'ja', 'ko', 'ar', 'hi'];

export class TranslationService {

    /**
     * Publishes a group (sets status to active) and triggers translation for its text content.
     */
    static async publishAndTranslate(groupId: string, groupName: string, groupType: 'exercise' | 'meal') {
        const movementId = this.normalizeToId(groupName);
        console.log(`[Translation] Publishing and Translating ${groupName} (${groupId})`);

        // 1. Promote Status: auto -> active
        // Function to update status for a key pattern
        const promoteAssets = async (prefix: string) => {
            await pool.query(
                `UPDATE cached_assets SET status = 'active' WHERE key LIKE $1 AND status = 'auto'`,
                [`${prefix}%`]
            );
        };

        const mainKey = groupType === 'exercise' ? `ex_${movementId}` : `meal_${movementId}`;
        await promoteAssets(mainKey);

        // 2. Fetch Text Content for Translation
        // We need: Main Description (from _meta), Step Instructions (from _meta or individual steps?)
        // Currently instructions are in `_meta`.

        const metaKey = `${mainKey}_meta`;
        const metaRes = await pool.query(`SELECT value FROM cached_assets WHERE key=$1`, [metaKey]);

        if (metaRes.rows.length > 0) {
            try {
                const meta = JSON.parse(metaRes.rows[0].value);

                // Collect texts to translate
                const textsToTranslate: { text: string, category: string }[] = [];

                if (meta.textContext) textsToTranslate.push({ text: meta.textContext, category: 'description' });
                if (meta.textContextSimple) textsToTranslate.push({ text: meta.textContextSimple, category: 'cue' });

                if (meta.steps && Array.isArray(meta.steps)) {
                    meta.steps.forEach((step: any, idx: number) => {
                        if (step.instruction) {
                            textsToTranslate.push({
                                text: step.instruction,
                                category: `step_${idx + 1}`
                            });
                        }
                    });
                }

                // 3. Process Translations (Batch)
                // We process each distinct text string.
                for (const item of textsToTranslate) {
                    await this.translateContent(item.text, item.category);
                }

                console.log(`[Translation] Completed for ${groupName}`);

            } catch (e) {
                console.error(`[Translation] Failed to parse meta for ${groupName}`, e);
            }
        }
    }

    /**
     * Translates a single text into ALL target languages using one Gemini call.
     * Caches results in content_translations.
     */
    static async translateContent(originalText: string, category: string) {
        if (!originalText || originalText.length < 2) return;

        // Check cache first (for at least one language to see if we did this)
        const cacheCheck = await pool.query(
            `SELECT 1 FROM content_translations WHERE original_text=$1 LIMIT 1`,
            [originalText]
        );
        if ((cacheCheck.rowCount || 0) > 0) {
            console.log(`[Translation] Cache hit for: "${originalText.substring(0, 20)}..."`);
            return;
        }

        console.log(`[Translation] Generating translations for: "${originalText.substring(0, 20)}..."`);

        const prompt = `
            Translate the following text into these languages: ${TARGET_LANGUAGES.join(', ')}.
            Text: "${originalText}"
            
            Return ONLY a JSON object where keys are language codes (es, fr, etc.) and values are the translation.
            Example: { "es": "...", "fr": "..." }
            Keep tone professional and instructional.
        `;

        try {
            const jsonStr = await generateAsset({
                mode: 'json',
                prompt: prompt
            });

            if (!jsonStr) throw new Error("No response from Gemini");

            const translations = JSON.parse(jsonStr);

            // Save to DB
            for (const lang of TARGET_LANGUAGES) {
                const translatedText = translations[lang];
                if (translatedText) {
                    await pool.query(
                        `INSERT INTO content_translations(original_text, language, translated_text, category)
                         VALUES($1, $2, $3, $4)
                         ON CONFLICT (original_text, language) DO UPDATE SET translated_text=EXCLUDED.translated_text`,
                        [originalText, lang, translatedText, category]
                    );
                }
            }

        } catch (e) {
            console.error(`[Translation] Error translating "${originalText.substring(0, 20)}..."`, e);
        }
    }

    private static normalizeToId(name: string): string {
        if (!name) return 'unknown';
        let clean = name.toLowerCase().trim();
        clean = clean.replace(/[^a-z0-9]+/g, ' ');
        const words = clean.split(' ').filter(w => w.length > 0).sort();
        return words.join('_');
    }
}
