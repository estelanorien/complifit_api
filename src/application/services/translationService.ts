import { pool } from '../../infra/db/pool.js';
import { AiService } from './aiService.js';
import { translationQueue } from './translationQueueService.js';
import { videoQueue } from './videoQueueService.js';

const aiService = new AiService();

export class TranslationService {
    private pendingTranslations = new Map<string, Promise<string>>();

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

        const contentHash = this.getContentHash(trimmedText);
        const lockKey = `${contentHash}_${lang}`;

        // 1. Check if already being translated
        if (this.pendingTranslations.has(lockKey)) {
            return this.pendingTranslations.get(lockKey)!;
        }

        const translationTask = (async () => {
            try {
                // 1. Check DB Cache
                const { rows } = await pool.query(
                    'SELECT translated_text FROM content_translations WHERE (content_hash = $1 OR original_text = $2) AND language = $3 LIMIT 1',
                    [contentHash, trimmedText, lang]
                );

                if (rows.length > 0) {
                    return rows[0].translated_text;
                }

                // 2. Not in cache, use AI
                const prompt = `You are a professional translator. Translate this text into the following language: ${lang}.
Return ONLY the translated text. Do not include any explanations, notes, or labels.
Text to translate:
${trimmedText}`;

                const { text: translated } = await aiService.generateText({
                    prompt,
                    model: 'models/gemini-3-flash-preview'
                });

                const cleanTranslated = translated.trim();
                if (!cleanTranslated) return trimmedText;

                // 3. Persist to cache (fire and forget)
                pool.query(
                    'INSERT INTO content_translations (original_text, language, translated_text, category, content_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (original_text, language) DO NOTHING',
                    [trimmedText, lang, cleanTranslated, category || 'general', contentHash]
                ).catch(() => { });

                return cleanTranslated;
            } catch (e: any) {
                process.stderr.write(`[TranslationService] AI translation error: ${e.message}\n`);
                return trimmedText;
            } finally {
                this.pendingTranslations.delete(lockKey);
            }
        })();

        this.pendingTranslations.set(lockKey, translationTask);
        return translationTask;
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

    /**
     * Publishes a group of assets and triggers translation and video queues.
     */
    async publishAndTranslate(groupId: string, groupName: string, groupType: 'exercise' | 'meal'): Promise<void> {
        try {
            // 1. Promote ALL assets in this group to 'active'
            await pool.query(
                `UPDATE cached_assets 
                 SET status = 'active' 
                 WHERE key IN (
                     SELECT key FROM cached_asset_meta WHERE movement_id = $1
                 )`,
                [groupId]
            );

            // 2. Find JSON assets that need translation
            const { rows: jsonRows } = await pool.query(
                `SELECT cached_assets.key 
                 FROM cached_assets 
                 JOIN cached_asset_meta ON cached_assets.key = cached_asset_meta.key
                 WHERE cached_asset_meta.movement_id = $1 
                 AND cached_assets.asset_type = 'json'`,
                [groupId]
            );

            for (const row of jsonRows) {
                await translationQueue.enqueue(row.key);
            }

            // 3. Trigger Video Generation
            // For exercises, we usually translate the 'Instructions' JSON asset to get the context.
            // We use that same asset key to trigger videos.
            if (jsonRows.length > 0) {
                const mainJsonAsset = jsonRows[0].key; // Usually the Instructions JSON

                if (groupType === 'exercise') {
                    await videoQueue.enqueue(mainJsonAsset, 'atlas');
                    await videoQueue.enqueue(mainJsonAsset, 'nova');
                } else {
                    await videoQueue.enqueue(mainJsonAsset, null);
                }
            }

        } catch (e) {
            throw e;
        }
    }
}

export const translationService = new TranslationService();
