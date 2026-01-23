
import { pool } from '../infra/db/pool.js';
import { generateAsset } from './AssetGenerationService.js';
import { env } from '../config/env.js';
import { AssetPromptService } from '../application/services/assetPromptService.js';

const TARGET_LANGUAGES = ['es', 'fr', 'de', 'it', 'pt', 'ru', 'tr', 'zh', 'ja', 'ko', 'ar', 'hi'];

export class TranslationService {

    /**
     * Publishes a group (sets status to active) and triggers translation for its text content.
     */
    static async publishAndTranslate(groupId: string, groupName: string, groupType: 'exercise' | 'meal') {
        const movementId = AssetPromptService.normalizeToId(groupName);
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
        const metaKey = `${mainKey}_meta`;
        const metaRes = await pool.query(`SELECT value FROM cached_assets WHERE key=$1`, [metaKey]);

        if (metaRes.rows.length > 0) {
            try {
                const meta = JSON.parse(metaRes.rows[0].value);

                // Collect texts to translate
                const textsToTranslate: { text: string, category: string }[] = [];

                if (meta.description) textsToTranslate.push({ text: meta.description, category: 'description' });

                // Exercise specific fields
                if (meta.safety_warnings && Array.isArray(meta.safety_warnings)) {
                    meta.safety_warnings.forEach((text: string, idx: number) => {
                        textsToTranslate.push({ text, category: `safety_${idx + 1}` });
                    });
                }
                if (meta.pro_tips && Array.isArray(meta.pro_tips)) {
                    meta.pro_tips.forEach((text: string, idx: number) => {
                        textsToTranslate.push({ text, category: `pro_tip_${idx + 1}` });
                    });
                }
                if (meta.common_mistakes && Array.isArray(meta.common_mistakes)) {
                    meta.common_mistakes.forEach((text: string, idx: number) => {
                        textsToTranslate.push({ text, category: `mistake_${idx + 1}` });
                    });
                }

                // Meal specific fields
                if (meta.nutrition_science) textsToTranslate.push({ text: meta.nutrition_science, category: 'nutrition' });
                if (meta.prep_tips && Array.isArray(meta.prep_tips)) {
                    meta.prep_tips.forEach((text: string, idx: number) => {
                        textsToTranslate.push({ text, category: `prep_tip_${idx + 1}` });
                    });
                }

                if (meta.instructions && Array.isArray(meta.instructions)) {
                    meta.instructions.forEach((step: any, idx: number) => {
                        if (step.label) {
                            textsToTranslate.push({
                                text: step.label,
                                category: `step_label_${idx + 1}`
                            });
                        }
                        if (step.detailed) {
                            textsToTranslate.push({
                                text: step.detailed,
                                category: `step_detailed_${idx + 1}`
                            });
                        }
                        if (step.simple) {
                            textsToTranslate.push({
                                text: step.simple,
                                category: `step_simple_${idx + 1}`
                            });
                        }
                    });
                }

                // 3. Process Translations (Batch)
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

        // Check cache first
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
}
