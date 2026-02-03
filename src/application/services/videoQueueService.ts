import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { pool } from '../../infra/db/pool.js';
import { logger } from '../../infra/logger.js';
import { env } from '../../config/env.js';
import { AiService } from './aiService.js';
import { buildNarrationScript } from './scriptBuilder.js';
import { synthesize as synthesizeTTS } from '../../services/audio/TTSClient.js';
import { mergeVideoAndAudio, getAudioDurationSeconds } from '../../services/video/ffmpegAssembler.js';
import { uploadToYouTube } from '../../services/youtubeService.js';
import { ensureScenePack, ensureStepScenePack, getClipsForAsset, getClipsWithUriForAsset } from '../../services/video/VeoDirector.js';
import { buildEditList, buildStepBasedEditList } from './editListBuilder.js';
import { assemble, assembleVideoOnly } from '../../services/video/VideoAssemblyService.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { retryManager } from './RetryManager.js';

const aiService = new AiService();

// Retry configuration for video jobs
const VIDEO_MAX_RETRIES = 3;
const RETRYABLE_ERROR_PATTERNS = ['429', '503', 'overloaded', 'quota', 'rate', 'timeout', 'UNAVAILABLE'];

/** Load coach reference image as data URI for video consistency. */
async function getCoachRefDataUri(persona: 'atlas' | 'nova'): Promise<string | null> {
    const key = persona === 'atlas' ? 'system_coach_atlas_ref' : 'system_coach_nova_ref';
    const asset = await AssetRepository.findByKey(key);
    if (!asset) return null;
    if (asset.buffer && asset.buffer.length > 0) {
        return `data:image/png;base64,${asset.buffer.toString('base64')}`;
    }
    if (asset.value && asset.value.length > 0) {
        return asset.value.startsWith('data:') ? asset.value : `data:image/png;base64,${asset.value}`;
    }
    return null;
}

// Location consistency: same setting for all videos (no beach vs gym mix)
const VIDEO_LOCATION_EXERCISE = 'Modern indoor gym, consistent set. Same environment for all fitness videos. No beach, no outdoor, no home. Professional fitness studio.';
const VIDEO_LOCATION_MEAL = 'Modern professional kitchen, consistent set. Same environment for all meal videos. No outdoor, no varied backgrounds.';

export class VideoQueueService {
    private processing = false;
    private intervalId: NodeJS.Timeout | null = null;
    private POLLING_INTERVAL = 5000; // 5 seconds (Video is slower, less frequent)

    constructor() {
        logger.info('[VideoQueue] Initialized');
    }

    start() {
        if (this.intervalId) return;
        logger.info('[VideoQueue] Starting worker...');
        this.intervalId = setInterval(() => this.processNextJob(), this.POLLING_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Enqueue a video generation job.
     * @param assetKey - The key of the asset (usually exercise or meal JSON)
     * @param persona - 'atlas', 'nova', or null for meals
     * @param options - withVoiceover: run TTS + merge + optional music per language; languages: default ['en']
     */
    async enqueue(assetKey: string, persona: string | null = null, options?: { withVoiceover?: boolean; languages?: string[] }): Promise<string> {
        try {
            const withVoiceover = options?.withVoiceover ?? false;
            const languages = options?.languages?.length ? options.languages : ['en'];
            let result: { rows: { id: string }[] };
            try {
                result = await pool.query(
                    `INSERT INTO video_jobs(asset_key, persona, status, with_voiceover, languages)
                     VALUES($1, $2, 'pending', $3, $4)
                     RETURNING id`,
                    [assetKey, persona, withVoiceover, languages]
                );
            } catch (e: any) {
                if ((e.message && (e.message.includes('with_voiceover') || e.message.includes('column')))) {
                    if (withVoiceover) logger.warn('[VideoQueue] Run migration 047_add_video_voiceover_options.sql to enable voiceover jobs.');
                    result = await pool.query(
                        `INSERT INTO video_jobs(asset_key, persona, status) VALUES($1, $2, 'pending') RETURNING id`,
                        [assetKey, persona]
                    );
                } else throw e;
            }
            const { rows } = result;
            logger.info(`[VideoQueue] Job created for ${assetKey} (${persona || 'meal'})`);

            // Set meta status
            await pool.query(
                `UPDATE cached_asset_meta SET video_status = 'pending', video_error = NULL WHERE key = $1`,
                [assetKey]
            );

            setImmediate(() => this.processNextJob());
            return rows[0].id;
        } catch (e: any) {
            logger.error(`[VideoQueue] Failed to enqueue job for ${assetKey}`, e);
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

                // 1. Lock Job (with_voiceover/languages from migration 047; fallback when columns missing)
                let rows: { id: string; asset_key: string; persona: string | null; with_voiceover?: boolean; languages?: string[] }[];
                try {
                    const r = await client.query(`
                        SELECT id, asset_key, persona,
                               COALESCE(with_voiceover, false) AS with_voiceover,
                               COALESCE(languages, ARRAY['en']) AS languages
                        FROM video_jobs
                        WHERE status = 'pending'
                        ORDER BY created_at ASC
                        LIMIT 1
                        FOR UPDATE SKIP LOCKED
                    `);
                    rows = r.rows;
                } catch (e: any) {
                    if (e.message && (e.message.includes('with_voiceover') || e.message.includes('column'))) {
                        const r = await client.query(`
                            SELECT id, asset_key, persona FROM video_jobs
                            WHERE status = 'pending'
                            ORDER BY created_at ASC
                            LIMIT 1
                            FOR UPDATE SKIP LOCKED
                        `);
                        rows = r.rows.map((row: any) => ({ ...row, with_voiceover: false, languages: ['en'] }));
                    } else throw e;
                }

                if (rows.length === 0) {
                    await client.query('ROLLBACK');
                    return;
                }

                const job = rows[0];
                logger.info(`[VideoQueue] Processing job ${job.id} (${job.asset_key})`);

                // Mark Processing
                await client.query(
                    `UPDATE video_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
                    [job.id]
                );

                await client.query(
                    `UPDATE cached_asset_meta SET video_status = 'processing' WHERE key = $1`,
                    [job.asset_key]
                );

                await client.query('COMMIT');

                // 2. Execute Video Generation (or Voiceover pipeline)
                try {
                    let resultUrl: string;
                    if (job.with_voiceover) {
                        resultUrl = await this.executeVoiceoverGeneration(
                            job.asset_key,
                            job.persona,
                            job.languages || ['en']
                        );
                    } else {
                        resultUrl = await this.executeVideoGeneration(job.asset_key, job.persona, job.id);
                    }

                    // Success
                    await pool.query(
                        `UPDATE video_jobs SET status = 'completed', result_url = $1, updated_at = NOW() WHERE id = $2`,
                        [resultUrl, job.id]
                    );

                    const videoKey = `${job.asset_key}_video` + (job.persona ? `_${job.persona}` : '');
                    if (!job.with_voiceover) {
                        await pool.query(
                            `INSERT INTO cached_assets(key, value, asset_type, status)
                              VALUES($1, $2, 'video', 'active')
                              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                            [videoKey, resultUrl]
                        );
                    }

                    await pool.query(
                        `UPDATE cached_asset_meta SET video_status = 'completed' WHERE key = $1`,
                        [job.asset_key]
                    );
                    logger.info(`[VideoQueue] Job ${job.id} COMPLETED. ${job.with_voiceover ? 'Voiceover' : 'Video'} saved.`);

                } catch (err: any) {
                    logger.error(`[VideoQueue] Job ${job.id} FAILED`, err);

                    // Check if error is retryable
                    const isRetryable = RETRYABLE_ERROR_PATTERNS.some(pattern =>
                        err.message?.toLowerCase().includes(pattern.toLowerCase())
                    );

                    // Get current retry count
                    const retryResult = await pool.query(
                        `SELECT retry_count FROM video_jobs WHERE id = $1`,
                        [job.id]
                    );
                    const currentRetryCount = retryResult.rows[0]?.retry_count || 0;

                    if (isRetryable && currentRetryCount < VIDEO_MAX_RETRIES) {
                        // Increment retry count and reset to pending for retry
                        await pool.query(
                            `UPDATE video_jobs SET status = 'pending', retry_count = $1, last_error = $2, updated_at = NOW() WHERE id = $3`,
                            [currentRetryCount + 1, err.message, job.id]
                        );
                        logger.info(`[VideoQueue] Job ${job.id} will retry (attempt ${currentRetryCount + 1}/${VIDEO_MAX_RETRIES})`);
                    } else {
                        // Max retries reached or non-retryable error - move to dead-letter
                        await pool.query(
                            `UPDATE video_jobs SET status = 'failed', retry_count = $1, last_error = $2, updated_at = NOW() WHERE id = $3`,
                            [currentRetryCount, err.message, job.id]
                        );
                        await pool.query(
                            `UPDATE cached_asset_meta SET video_status = 'failed', video_error = $1 WHERE key = $2`,
                            [err.message, job.asset_key]
                        );

                        // Move to dead-letter queue
                        await retryManager.moveToDeadLetter(
                            job.id,
                            'video',
                            job.asset_key,
                            { jobId: job.id, assetKey: job.asset_key, persona: job.persona, withVoiceover: job.with_voiceover },
                            err.message,
                            err.stack || null,
                            currentRetryCount + 1
                        );
                        logger.error(`[VideoQueue] Job ${job.id} moved to dead-letter queue after ${currentRetryCount + 1} attempts`);
                    }
                }

            } catch (err) {
                await client.query('ROLLBACK');
                logger.error('[VideoQueue] Transaction error', err as Error);
            } finally {
                client.release();
            }

        } finally {
            this.processing = false;
        }
    }

    /**
     * Director-cut step-based: one 8s clip per instruction step (with angle variety per step), stitched in order.
     * Each step is explicitly shown and can be narrated. Same for exercises and meals.
     */
    private async executeVideoGeneration(assetKey: string, persona: string | null, jobId: string): Promise<string> {
        const { rows } = await pool.query(
            `SELECT value, asset_type FROM cached_assets WHERE key = $1`,
            [assetKey]
        );
        if (rows.length === 0) throw new Error('Asset not found');

        const data = JSON.parse(rows[0].value);
        const name = assetKey.split('_').slice(1).join(' ');
        const instructions = data.instructions ?? data.recipe;
        const meta = { name: data.name || name, instructions, type: data.type || 'exercise' };

        // 1. Step scene pack: one 8s clip per instruction step (director angle variety per step)
        await ensureStepScenePack({ assetKey, assetMeta: meta, coachId: persona });
        const clipsWithUri = await getClipsWithUriForAsset(assetKey, persona);
        if (clipsWithUri.length === 0) throw new Error('Step scene pack failed: no clips');

        // 2. Edit list: one segment per step in order, 8s each (each step explicitly shown)
        const editListWithUri: Array<{ clipId: string; shot_type: string; durationSeconds: number; uri: string }> = clipsWithUri.map(
            (c: { id: string; shot_type: string; uri: string }) => ({ clipId: c.id, shot_type: c.shot_type, durationSeconds: 8, uri: c.uri })
        );
        if (editListWithUri.length === 0) throw new Error('No clip URIs for assembly');

        // 3. Assemble video-only (no TTS)
        const assembledDir = path.join(process.cwd(), 'data', 'assembled');
        fs.mkdirSync(assembledDir, { recursive: true });
        const outPath = path.join(assembledDir, `${jobId}.mp4`);
        await assembleVideoOnly(editListWithUri, outPath);

        // 4. Return URL path the frontend can use (same-origin or API base + path)
        return `/admin/assembled-video/${jobId}.mp4`;
    }

    /**
     * Voiceover pipeline: B-roll (scene pack) when 3+ clips exist; else single Veo clip + TTS + merge.
     * Returns first language URL for result_url; stores per language in cached_assets and localized_videos.
     */
    private async executeVoiceoverGeneration(assetKey: string, persona: string | null, languages: string[]): Promise<string> {
        const { rows } = await pool.query(`SELECT value FROM cached_assets WHERE key = $1`, [assetKey]);
        if (rows.length === 0) throw new Error('Asset not found');
        const data = JSON.parse(rows[0].value);
        const name = assetKey.split('_').slice(1).join(' ');
        const instructions = data.instructions ?? data.recipe;
        const meta = { name: data.name || name, instructions, type: data.type || 'exercise' };
        const script = buildNarrationScript(meta, 200);
        if (!script.trim()) throw new Error('Empty narration script');

        const hasSteps = (meta.instructions?.instructions?.length ?? 0) > 0;
        if (hasSteps) {
            await ensureStepScenePack({ assetKey, assetMeta: meta, coachId: persona });
        } else {
            await ensureScenePack({ assetKey, assetMeta: meta, coachId: persona });
        }
        const clipsWithUri = await getClipsWithUriForAsset(assetKey, persona);
        const useBroll = clipsWithUri.length >= 3;
        const useStepBased = useBroll && hasSteps && clipsWithUri.some((c: { step_index?: number }) => c.step_index != null);

        const tmpDir = path.join(os.tmpdir(), `voiceover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const musicUri = env.videoMusicTrackUri;
        let firstUrl = '';

        try {
            if (useBroll) {
                const clipRows = await getClipsForAsset(assetKey, persona);
                for (const lang of languages) {
                    const { audioBuffer, timepoints } = await synthesizeTTS(script, lang, { enableTimePointing: true });
                    const ttsPath = path.join(tmpDir, `tts_${lang}.mp3`);
                    fs.writeFileSync(ttsPath, audioBuffer);
                    const totalDurationSeconds = await getAudioDurationSeconds(ttsPath);
                    const editList = useStepBased
                        ? buildStepBasedEditList(timepoints || [], clipRows, totalDurationSeconds)
                        : buildEditList(timepoints || [], clipRows, totalDurationSeconds);
                    const clipById = new Map(clipsWithUri.map((c: { id: string; uri: string }) => [c.id, c]));
                    const editListWithUri: Array<{ clipId: string; shot_type: string; durationSeconds: number; uri: string }> = [];
                    for (const seg of editList) {
                        const clip = clipById.get(seg.clipId);
                        if (clip?.uri) editListWithUri.push({ clipId: seg.clipId, shot_type: seg.shot_type, durationSeconds: seg.durationSeconds, uri: clip.uri });
                    }
                    if (editListWithUri.length === 0) throw new Error('No clip URIs for assembly');
                    const outPath = path.join(tmpDir, `merged_${lang}.mp4`);
                    await assemble(editListWithUri, audioBuffer, outPath, musicUri ? { musicUri } : {});
                    const passed = await this.verifyAssembledVideo(outPath, editList);
                    let url = '';
                    if (env.youtube?.clientId && env.youtube?.clientSecret && env.youtube?.refreshToken) {
                        const { url: ytUrl } = await uploadToYouTube({
                            videoUrl: outPath,
                            title: `${data.name || name} (${lang})`,
                            description: `Voiceover: ${lang}`,
                            privacyStatus: 'unlisted'
                        });
                        url = ytUrl;
                    } else url = outPath;
                    if (!firstUrl) firstUrl = url;
                    await pool.query(
                        `INSERT INTO localized_videos (parent_id, language_code, youtube_url, status, verification_status, review_status)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (parent_id, language_code) DO UPDATE SET
                           youtube_url = EXCLUDED.youtube_url, status = EXCLUDED.status,
                           verification_status = EXCLUDED.verification_status, review_status = EXCLUDED.review_status`,
                        [assetKey, lang, url || null, url ? 'UPLOADED' : 'PROCESSING', passed ? 'passed' : 'failed', passed ? 'ready_for_review' : 'revision_requested']
                    );
                    const voiceoverKey = `${assetKey}_video_voiceover_${lang}`;
                    await pool.query(
                        `INSERT INTO cached_assets(key, value, asset_type, status) VALUES($1, $2, 'video', 'active')
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                        [voiceoverKey, url]
                    );
                }
            } else {
                const voiceoverJobId = `vo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const videoUrl = await this.executeVideoGeneration(assetKey, persona, voiceoverJobId);
                for (const lang of languages) {
                    const { audioBuffer } = await synthesizeTTS(script, lang, { enableTimePointing: false });
                    const outPath = path.join(tmpDir, `merged_${lang}.mp4`);
                    await mergeVideoAndAudio(videoUrl, audioBuffer, outPath, musicUri ? { musicUri } : {});
                    let url = '';
                    if (env.youtube?.clientId && env.youtube?.clientSecret && env.youtube?.refreshToken) {
                        const { url: ytUrl } = await uploadToYouTube({
                            videoUrl: outPath,
                            title: `${data.name || name} (${lang})`,
                            description: `Voiceover: ${lang}`,
                            privacyStatus: 'unlisted'
                        });
                        url = ytUrl;
                    } else url = outPath;
                    if (!firstUrl) firstUrl = url;
                    const voiceoverKey = `${assetKey}_video_voiceover_${lang}`;
                    await pool.query(
                        `INSERT INTO cached_assets(key, value, asset_type, status) VALUES($1, $2, 'video', 'active')
                         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                        [voiceoverKey, url]
                    );
                }
            }
            return firstUrl || '(no URL)';
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        }
    }

    private async verifyAssembledVideo(outputPath: string, editList: Array<{ shot_type: string; durationSeconds: number }>): Promise<boolean> {
        let prev: string | null = null;
        for (const seg of editList) {
            if (seg.shot_type === prev) return false;
            prev = seg.shot_type;
        }
        let sum = 0;
        const typesIn30 = new Set<string>();
        for (const seg of editList) {
            typesIn30.add(seg.shot_type);
            sum += seg.durationSeconds;
            if (sum >= 30) break;
        }
        if (typesIn30.size < 2) return false;
        return new Promise((resolve) => {
            const proc = spawn('ffprobe', [
                '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json',
                outputPath
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
            proc.on('close', (code: number) => {
                if (code !== 0) { resolve(false); return; }
                try {
                    const j = JSON.parse(out);
                    const duration = Number(j.format?.duration ?? 0);
                    const w = Number(j.streams?.[0]?.width ?? 0);
                    const h = Number(j.streams?.[0]?.height ?? 0);
                    resolve(duration >= 20 && duration <= 120 && w === 1920 && h === 1080);
                } catch (_) { resolve(false); }
            });
            proc.on('error', () => resolve(false));
        });
    }
}

export const videoQueue = new VideoQueueService();
