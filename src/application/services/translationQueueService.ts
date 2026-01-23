
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { AiService } from './aiService.js';

const aiService = new AiService();

export class TranslationQueueService {
    private processing = false;
    private intervalId: NodeJS.Timeout | null = null;
    private POLLING_INTERVAL = 3000; // 3 seconds

    constructor() {
        logger.info('[TranslationQueue] Initialized');
    }

    start() {
        if (this.intervalId) return;
        logger.info('[TranslationQueue] Starting worker...');
        this.intervalId = setInterval(() => this.processNextJob(), this.POLLING_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Enqueue a translation job for an asset.
     */
    async enqueue(assetKey: string, languages: string[] = ['es', 'fr', 'de', 'it', 'pt', 'ru', 'tr', 'zh', 'ja', 'ko', 'ar', 'hi']): Promise<string> {
        // #region agent log
        const fs = await import('fs/promises');
        const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
        const logEntry = JSON.stringify({location:'translationQueueService.ts:33',message:'Translation job enqueued',data:{assetKey,languagesCount:languages.length,languages},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'}) + '\n';
        fs.appendFile(logPath, logEntry).catch(()=>{});
        // #endregion
        try {
            const { rows } = await pool.query(
                `INSERT INTO translation_jobs(asset_key, target_languages, status)
                 VALUES($1, $2, 'pending')
                 RETURNING id`,
                [assetKey, languages]
            );
            logger.info(`[TranslationQueue] Job created for ${assetKey}`);

            // Set high-level status on asset meta
            await pool.query(
                `UPDATE cached_asset_meta SET translation_status = 'pending', translation_error = NULL WHERE key = $1`,
                [assetKey]
            );

            setImmediate(() => this.processNextJob());
            return rows[0].id;
        } catch (e: any) {
            logger.error(`[TranslationQueue] Failed to enqueue job for ${assetKey}`, e);
            throw e;
        }
    }

    private async processNextJob() {
        if (this.processing) return;

        try {
            this.processing = true;
            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                // 1. Lock Job
                const { rows } = await client.query(`
                    SELECT id, asset_key, target_languages 
                    FROM translation_jobs 
                    WHERE status = 'pending'
                    ORDER BY created_at ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                `);

                if (rows.length === 0) {
                    await client.query('ROLLBACK');
                    return;
                }

                const job = rows[0];
                logger.info(`[TranslationQueue] Processing job ${job.id} (${job.asset_key})`);

                // Mark Processing
                await client.query(
                    `UPDATE translation_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
                    [job.id]
                );

                await client.query(
                    `UPDATE cached_asset_meta SET translation_status = 'processing' WHERE key = $1`,
                    [job.asset_key]
                );

                await client.query('COMMIT');

                // 2. Execute Translation
                try {
                    // #region agent log
                    const fs = await import('fs/promises');
                    const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
                    const logEntry = JSON.stringify({location:'translationQueueService.ts:100',message:'Translation execution start',data:{jobId:job.id,assetKey:job.asset_key,languagesCount:job.target_languages?.length||0,languages:job.target_languages},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'}) + '\n';
                    fs.appendFile(logPath, logEntry).catch(()=>{});
                    // #endregion
                    await this.executeTranslation(job.asset_key, job.target_languages);

                    // Success
                    await pool.query(
                        `UPDATE translation_jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
                        [job.id]
                    );
                    await pool.query(
                        `UPDATE cached_asset_meta SET translation_status = 'completed' WHERE key = $1`,
                        [job.asset_key]
                    );
                    logger.info(`[TranslationQueue] Job ${job.id} COMPLETED`);
                    // #region agent log
                    const logEntry2 = JSON.stringify({location:'translationQueueService.ts:111',message:'Translation job completed',data:{jobId:job.id,assetKey:job.asset_key},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.1'}) + '\n';
                    fs.appendFile(logPath, logEntry2).catch(()=>{});
                    // #endregion

                } catch (err: any) {
                    logger.error(`[TranslationQueue] Job ${job.id} FAILED`, err);
                    // #region agent log
                    const fs = await import('fs/promises');
                    const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
                    const logEntry = JSON.stringify({location:'translationQueueService.ts:114',message:'Translation job failed',data:{jobId:job.id,assetKey:job.asset_key,error:err.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.2'}) + '\n';
                    fs.appendFile(logPath, logEntry).catch(()=>{});
                    // #endregion

                    // Retry logic? For now just fail. V2.1 can add retries.
                    await pool.query(
                        `UPDATE translation_jobs SET status = 'failed', error_log = $1, updated_at = NOW() WHERE id = $2`,
                        [err.message, job.id]
                    );
                    await pool.query(
                        `UPDATE cached_asset_meta SET translation_status = 'failed', translation_error = $1 WHERE key = $2`,
                        [err.message, job.asset_key]
                    );
                }

            } catch (err) {
                await client.query('ROLLBACK');
                logger.error('[TranslationQueue] Transaction error', err as Error);
            } finally {
                client.release();
            }

        } finally {
            this.processing = false;
        }
    }

    private async executeTranslation(assetKey: string, languages: string[]) {
        // 1. Fetch Asset Content
        const { rows } = await pool.query(
            `SELECT value, asset_type, meta.prompt 
             FROM cached_assets 
             LEFT JOIN cached_asset_meta meta ON meta.key = cached_assets.key
             WHERE cached_assets.key = $1`,
            [assetKey]
        );

        if (rows.length === 0) throw new Error(`Asset ${assetKey} not found`);
        const { value, asset_type } = rows[0];

        // 2. Extract Text to Translate
        let textsToTranslate: { original: string, context: string }[] = [];

        if (asset_type === 'json') {
            const data = JSON.parse(value);
            // #region agent log
            const fs = await import('fs/promises');
            const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
            const logEntry = JSON.stringify({location:'translationQueueService.ts:152',message:'Text extraction from JSON',data:{assetKey,hasInstructions:!!data.instructions,instructionsCount:data.instructions?.length||0,hasSafetyWarnings:!!data.safety_warnings,safetyWarningsCount:data.safety_warnings?.length||0,hasProTips:!!data.pro_tips,proTipsCount:data.pro_tips?.length||0,hasNutritionScience:!!data.nutrition_science,hasPrepTips:!!data.prep_tips,prepTipsCount:data.prep_tips?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.3'}) + '\n';
            fs.appendFile(logPath, logEntry).catch(()=>{});
            // #endregion
            // Heuristic extraction
            if (data.instructions && Array.isArray(data.instructions)) {
                data.instructions.forEach((s: any) => {
                    const text = typeof s === 'string' ? s : (s.detailed || s.simple);
                    if (text) textsToTranslate.push({ original: text, context: 'Instruction Step' });
                });
            }
            // Add other logical fields if needed (ingredients, etc if passed in JSON asset)
            // Extract safety_warnings, pro_tips, nutrition_science, prep_tips
            if (data.safety_warnings && Array.isArray(data.safety_warnings)) {
                data.safety_warnings.forEach((text: string) => {
                    if (text) textsToTranslate.push({ original: text, context: 'Safety Warning' });
                });
            }
            if (data.pro_tips && Array.isArray(data.pro_tips)) {
                data.pro_tips.forEach((text: string) => {
                    if (text) textsToTranslate.push({ original: text, context: 'Pro Tip' });
                });
            }
            if (data.nutrition_science && typeof data.nutrition_science === 'string') {
                textsToTranslate.push({ original: data.nutrition_science, context: 'Nutrition Science' });
            }
            if (data.prep_tips && Array.isArray(data.prep_tips)) {
                data.prep_tips.forEach((text: string) => {
                    if (text) textsToTranslate.push({ original: text, context: 'Prep Tip' });
                });
            }
        } else if (asset_type === 'image') {
            // Images don't have text content usually, UNLESS we translate the metadata prompt?
            // Usually we only translate "Movements" (which are groups).
            // But if `assetKey` is passing a MOVEMENT ID, we might need to look up component parts.
            // Our Migration said `asset_key` references `cached_assets`.
            // If the job was created for a "Group", maybe we passed the "Instructions JSON Asset Key".
            // Yes, usually we translate the Instructions Asset.

            // If it's an image, maybe we just complete it?
            return;
        }

        // #region agent log
        const fs = await import('fs/promises');
        const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
        const logEntry = JSON.stringify({location:'translationQueueService.ts:177',message:'Texts to translate extracted',data:{assetKey,textsToTranslateCount:textsToTranslate.length,textsByContext:textsToTranslate.reduce((acc,t)=>{acc[t.context]=(acc[t.context]||0)+1;return acc;},{})},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.3'}) + '\n';
        fs.appendFile(logPath, logEntry).catch(()=>{});
        // #endregion

        if (textsToTranslate.length === 0) return;

        // 3. Batch Translate via Gemini
        // We package all texts into one prompt to save tokens/calls
        const combinedText = textsToTranslate.map((t, i) => `[ID:${i}] ${t.original}`).join('\n\n');

        // Loop through languages
        // Optimization: Translate to ALL languages in one go? 
        // Gemini 1.5/2.0 context is large enough.
        // Prompt: "Translate the following texts into ES, FR, DE... Return JSON { "es": { "ID:0": "..." } }"
        // This is extremely efficient.

        const langList = languages.join(', ');
        const prompt = `You are a professional fitness translator. Translate the following texts into these languages: ${langList}.
        
        INPUT TEXTS:
        ${combinedText}
        
        OUTPUT FORMAT:
        Return a valid JSON object where keys are language codes (${langList}) and values are objects mapping the ID (e.g. "ID:0") to the translated string.
        Example:
        {
          "es": { "ID:0": "Translated text..." },
          "fr": { "ID:0": "Translated text..." }
        }
        Do not include markdown blocks. Just raw JSON.`;

        const { text: jsonResult } = await aiService.generateText({
            prompt,
            model: 'models/gemini-2.0-flash' // Fast model
        });

        let parsed;
        try {
            parsed = JSON.parse(jsonResult.replace(/```json|```/g, '').trim());
        } catch (e) {
            throw new Error("Failed to parse AI translation response");
        }

        // 4. Save to content_translations
        let savedCount = 0;
        for (const lang of Object.keys(parsed)) {
            const translations = parsed[lang];
            for (const idKey of Object.keys(translations)) {
                const index = parseInt(idKey.split(':')[1]);
                if (!isNaN(index) && textsToTranslate[index]) {
                    const original = textsToTranslate[index].original;
                    const translated = translations[idKey];
                    const contentHash = this.getContentHash(original);

                    await pool.query(
                        `INSERT INTO content_translations (original_text, language, translated_text, category, content_hash)
                         VALUES ($1, $2, $3, 'auto-queue', $4)
                         ON CONFLICT (original_text, language) DO UPDATE SET translated_text = EXCLUDED.translated_text`,
                        [original, lang, translated, contentHash]
                    );
                    savedCount++;
                }
            }
        }
        // #region agent log
        const fs = await import('fs/promises');
        const logPath = 'c:\\Users\\rmkoc\\Downloads\\vitapp2\\.cursor\\debug.log';
        const logEntry = JSON.stringify({location:'translationQueueService.ts:230',message:'Translations saved',data:{assetKey,languagesCount:Object.keys(parsed).length,savedTranslationsCount:savedCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H3.4'}) + '\n';
        fs.appendFile(logPath, logEntry).catch(()=>{});
        // #endregion
    }

    private getContentHash(text: string): string {
        if (!text) return '0';
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = (hash * 33) ^ text.charCodeAt(i);
        }
        return (hash >>> 0).toString(36);
    }
}

export const translationQueue = new TranslationQueueService();
