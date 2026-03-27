/**
 * VideoOrchestrator - Phase 2 Video Pipeline
 *
 * Orchestrates the creation of 45-60 second professional exercise videos with:
 * - Multiple camera angles (ESTABLISHING, CLOSE_UP, OVERHEAD, ACTION)
 * - TTS voiceover with timepoint-driven cuts
 * - Background music mixing
 * - Automatic quality verification
 */

import { ensureScenePack, ClipResult, VeoDirectorInput } from '../../services/video/VeoDirector.js';
import { synthesize } from '../../services/audio/TTSClient.js';
import { buildEditList } from './editListBuilder.js';
import { assemble, EditSegmentWithUri } from '../../services/video/VideoAssemblyService.js';
import { VideoVerifier } from '../../services/video/VideoVerifier.js';
import { uploadToYouTube } from '../../services/youtubeService.js';
import { pool } from '../../infra/db/pool.js';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../infra/logger.js';
import { env } from '../../config/env.js';

const storage = new Storage();
const GCS_BUCKET = process.env.GCS_VIDEO_BUCKET || 'vitality-videos';

export interface Phase2VideoRequest {
  assetKey: string;           // ex:bench_press
  coachId: 'atlas' | 'nova';
  languages: string[];        // ['en', 'tr', 'es', ...]
  options?: {
    musicUri?: string;
    transitionType?: 'cut' | 'xfade';
    transitionDuration?: number; // 0.3s default
    autoUploadYouTube?: boolean; // Auto-upload to YouTube if verification passes
    youtubePrivacy?: 'private' | 'unlisted' | 'public';
  };
}

export interface LocalizedVideoResult {
  language: string;
  gcsPath: string;
  duration: number;
  verificationStatus: 'passed' | 'failed';
  verificationNotes: string;
  youtubeId?: string;
  youtubeUrl?: string;
}

export interface Phase2VideoResult {
  success: boolean;
  assetKey: string;
  coachId: string;
  localizedVideos: LocalizedVideoResult[];
  errors?: string[];
  totalDuration?: number;
}

export class VideoOrchestrator {
  private verifier: VideoVerifier;

  constructor() {
    this.verifier = new VideoVerifier();
  }

  /**
   * Execute Phase 2 video generation pipeline
   */
  async executePhase2(request: Phase2VideoRequest): Promise<Phase2VideoResult> {
    const errors: string[] = [];
    const localizedVideos: LocalizedVideoResult[] = [];

    logger.info('[VideoOrchestrator] Starting Phase 2', { assetKey: request.assetKey, coachId: request.coachId });

    try {
      // 1. Load asset meta
      const meta = await this.loadAssetMeta(request.assetKey);
      if (!meta) {
        throw new Error(`Asset meta not found for ${request.assetKey}`);
      }

      // 2. Ensure 4 source clips exist (ESTABLISHING, CLOSE_UP, OVERHEAD, ACTION)
      logger.info('[VideoOrchestrator] Ensuring scene pack');
      const clips = await ensureScenePack({
        assetKey: request.assetKey,
        coachId: request.coachId,
        assetMeta: {
          name: meta.name || request.assetKey,
          type: meta.type as 'exercise' | 'meal' | undefined,
          instructions: { instructions: meta.instructions }
        }
      });

      if (clips.length < 3) {
        throw new Error(`Insufficient clips generated: ${clips.length} (need at least 3)`);
      }

      logger.info('[VideoOrchestrator] Scene pack ready', { clipCount: clips.length });

      // 3. For each language, create localized video
      for (const lang of request.languages) {
        try {
          const result = await this.createLocalizedVideo(
            request.assetKey,
            request.coachId,
            lang,
            meta,
            clips,
            request.options
          );
          localizedVideos.push(result);
        } catch (langError) {
          const error = langError as Error;
          logger.error('[VideoOrchestrator] Failed for language', error, { language: lang });
          errors.push(`${lang}: ${error.message}`);
        }
      }

      return {
        success: errors.length === 0,
        assetKey: request.assetKey,
        coachId: request.coachId,
        localizedVideos,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (e) {
      const error = e as Error;
      logger.error('[VideoOrchestrator] Pipeline failed', error);
      return {
        success: false,
        assetKey: request.assetKey,
        coachId: request.coachId,
        localizedVideos: [],
        errors: [error.message]
      };
    }
  }

  /**
   * Create a single localized video (one language)
   */
  private async createLocalizedVideo(
    assetKey: string,
    coachId: string,
    lang: string,
    meta: AssetMeta,
    clips: ClipResult[],
    options?: Phase2VideoRequest['options']
  ): Promise<LocalizedVideoResult> {
    logger.info('[VideoOrchestrator] Creating video', { assetKey, coachId, language: lang });

    // 1. Build script from meta instructions
    const script = this.buildScript(meta, lang);

    // 2. Generate TTS with timepoints
    logger.info('[VideoOrchestrator] Generating TTS');
    const tts = await synthesize(script, lang, { enableTimePointing: true });
    const audioDuration = this.estimateAudioDuration(tts.audioBuffer);

    logger.info('[VideoOrchestrator] TTS generated', { audioDuration: audioDuration.toFixed(1), timepointCount: tts.timepoints?.length || 0 });

    // 3. Build edit list using timepoints (cinematic rules, no jump cuts)
    // Convert ClipResult to the format expected by buildEditList
    const clipRows = clips.map(c => ({
      id: c.id || c.uri, // Use URI as fallback ID
      shot_type: c.shotType
    }));

    const editList = buildEditList(
      tts.timepoints || [],
      clipRows,
      audioDuration
    );

    logger.info('[VideoOrchestrator] Edit list built', { segmentCount: editList.length });

    // 4. Map edit list to URIs
    const editListWithUris: EditSegmentWithUri[] = editList.map(segment => {
      // Find clip by shot_type (segment.clipId may be the shot_type or actual ID)
      const clip = clips.find(c =>
        (c.id && c.id === segment.clipId) ||
        c.shotType === segment.shot_type
      );
      if (!clip) {
        throw new Error(`Clip not found for shot type: ${segment.shot_type}`);
      }
      return {
        ...segment,
        uri: clip.uri
      };
    });

    // 5. Assemble final video
    const outputPath = path.join('/tmp', `${assetKey.replace(/:/g, '_')}_${coachId}_${lang}_${Date.now()}.mp4`);

    logger.info('[VideoOrchestrator] Assembling video');
    await assemble(
      editListWithUris,
      tts.audioBuffer,
      outputPath,
      {
        musicUri: options?.musicUri || env.videoMusicTrackUri,
        transitionType: options?.transitionType || 'cut',
        transitionDuration: options?.transitionDuration || 0.3
      }
    );

    // 6. Verify quality
    logger.info('[VideoOrchestrator] Verifying video');
    const verification = await this.verifier.verify(outputPath, editList);

    // 7. Upload to GCS
    const gcsPath = await this.uploadToGcs(outputPath, assetKey, coachId, lang);

    // 8. Auto-upload to YouTube if enabled and verification passed
    let youtubeId: string | undefined;
    let youtubeUrl: string | undefined;

    if (options?.autoUploadYouTube && verification.passed) {
      logger.info('[VideoOrchestrator] Uploading to YouTube');
      try {
        const exerciseName = meta.name || assetKey.split(':').pop() || 'Exercise';
        const coachName = coachId === 'atlas' ? 'Atlas' : 'Nova';

        // Generate signed URL from GCS
        const bucket = storage.bucket(GCS_BUCKET);
        const [signedUrl] = await bucket.file(gcsPath.replace(`gs://${GCS_BUCKET}/`, '')).getSignedUrl({
          action: 'read',
          expires: Date.now() + 30 * 60 * 1000 // 30 min
        });

        const ytResult = await uploadToYouTube({
          videoUrl: signedUrl,
          title: `${exerciseName} - ${coachName} (${lang.toUpperCase()})`,
          description: `Professional exercise tutorial by Coach ${coachName}.\n\n` +
            `Exercise: ${exerciseName}\n` +
            `Language: ${lang.toUpperCase()}\n\n` +
            `Generated by Vitality AI Video Pipeline.`,
          privacyStatus: options.youtubePrivacy || 'unlisted'
        });

        youtubeId = ytResult.videoId ?? undefined;
        youtubeUrl = ytResult.url;
        logger.info('[VideoOrchestrator] YouTube upload complete', { youtubeUrl });
      } catch (ytError) {
        const error = ytError as Error;
        logger.error('[VideoOrchestrator] YouTube upload failed', error);
        // Don't fail the whole operation, just log the error
      }
    }

    // 9. Save to database
    await this.saveLocalizedVideo({
      parentId: assetKey,
      languageCode: lang,
      gcsPath,
      status: 'UPLOADED',
      verificationStatus: verification.passed ? 'passed' : 'failed',
      verificationNotes: verification.notes,
      youtubeId,
      youtubeUrl
    });

    // 10. Cleanup temp file
    try {
      fs.unlinkSync(outputPath);
    } catch { /* ignore */ }

    logger.info('[VideoOrchestrator] Video complete', { gcsPath, verificationPassed: verification.passed, youtubeUrl });

    return {
      language: lang,
      gcsPath,
      duration: verification.duration,
      verificationStatus: verification.passed ? 'passed' : 'failed',
      verificationNotes: verification.notes,
      youtubeId,
      youtubeUrl
    };
  }

  /**
   * Load asset meta from database
   */
  private async loadAssetMeta(assetKey: string): Promise<AssetMeta | null> {
    const metaKey = `${assetKey}:none:meta:0`;
    const result = await pool.query(
      `SELECT value FROM cached_assets WHERE key = $1 AND status = 'active'`,
      [metaKey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    try {
      return JSON.parse(result.rows[0].value);
    } catch {
      return null;
    }
  }

  /**
   * Build voiceover script from meta instructions
   */
  private buildScript(meta: AssetMeta, lang: string): string {
    const parts: string[] = [];

    // Exercise name
    if (meta.name) {
      parts.push(`<mark name="intro"/>${meta.name}.`);
    }

    // Instructions with marks for timepoints
    if (meta.instructions && Array.isArray(meta.instructions)) {
      meta.instructions.forEach((instruction, i) => {
        parts.push(`<mark name="step${i + 1}"/>Step ${i + 1}. ${instruction}`);
      });
    }

    // Safety tip
    if (meta.safetyWarnings && meta.safetyWarnings.length > 0) {
      parts.push(`<mark name="safety"/>Remember: ${meta.safetyWarnings[0]}`);
    }

    return `<speak>${parts.join(' ')}</speak>`;
  }

  /**
   * Estimate audio duration from buffer (MP3 at 24kHz)
   */
  private estimateAudioDuration(buffer: Buffer): number {
    // Rough estimate: MP3 at 128kbps = 16KB per second
    return buffer.length / 16000;
  }

  /**
   * Upload video to Google Cloud Storage
   */
  private async uploadToGcs(
    localPath: string,
    assetKey: string,
    coachId: string,
    lang: string
  ): Promise<string> {
    const fileName = `phase2/${assetKey.replace(/:/g, '/')}/${coachId}/${lang}/${randomUUID()}.mp4`;
    const bucket = storage.bucket(GCS_BUCKET);

    await bucket.upload(localPath, {
      destination: fileName,
      metadata: {
        contentType: 'video/mp4',
        metadata: {
          assetKey,
          coachId,
          language: lang,
          pipeline: 'phase2'
        }
      }
    });

    return `gs://${GCS_BUCKET}/${fileName}`;
  }

  /**
   * Save localized video record to database
   */
  private async saveLocalizedVideo(data: {
    parentId: string;
    languageCode: string;
    gcsPath: string;
    status: string;
    verificationStatus: string;
    verificationNotes: string;
    youtubeId?: string;
    youtubeUrl?: string;
  }): Promise<void> {
    await pool.query(`
      INSERT INTO localized_videos (
        id, parent_id, language_code, gcs_path,
        status, verification_status, verification_notes,
        review_status, youtube_id, youtube_url, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready_for_review', $8, $9, NOW())
      ON CONFLICT (parent_id, language_code)
      DO UPDATE SET
        gcs_path = EXCLUDED.gcs_path,
        status = EXCLUDED.status,
        verification_status = EXCLUDED.verification_status,
        verification_notes = EXCLUDED.verification_notes,
        review_status = 'ready_for_review',
        youtube_id = EXCLUDED.youtube_id,
        youtube_url = EXCLUDED.youtube_url,
        created_at = NOW()
    `, [
      randomUUID(),
      data.parentId,
      data.languageCode,
      data.gcsPath,
      data.status,
      data.verificationStatus,
      data.verificationNotes,
      data.youtubeId || null,
      data.youtubeUrl || null
    ]);
  }

  /**
   * Retry a failed YouTube upload for an existing localized video
   */
  async retryYouTubeUpload(videoId: string): Promise<{ success: boolean; youtubeUrl?: string }> {
    const { rows } = await pool.query(
      `SELECT parent_id, language_code, gcs_path, youtube_id FROM localized_videos WHERE id = $1`,
      [videoId]
    );
    if (rows.length === 0) throw new Error('Video not found');
    const video = rows[0];
    if (!video.gcs_path) throw new Error('No GCS path available for retry');
    if (video.youtube_id) throw new Error('Video already uploaded to YouTube');

    // Generate signed URL from GCS
    const bucket = storage.bucket(GCS_BUCKET);
    const [signedUrl] = await bucket.file(video.gcs_path.replace(`gs://${GCS_BUCKET}/`, '')).getSignedUrl({
      action: 'read',
      expires: Date.now() + 30 * 60 * 1000 // 30 min
    });

    const { uploadToYouTube } = await import('../../services/youtubeService.js');
    const ytResult = await uploadToYouTube({
      videoUrl: signedUrl,
      title: `Exercise - ${video.parent_id} (${video.language_code.toUpperCase()})`,
      description: `Generated by Vitality AI Video Pipeline.`,
      privacyStatus: 'unlisted'
    });

    // Update DB
    await pool.query(
      `UPDATE localized_videos SET youtube_id = $2, youtube_url = $3 WHERE id = $1`,
      [videoId, ytResult.videoId, ytResult.url]
    );

    logger.info('[VideoOrchestrator] YouTube retry succeeded', { videoId, youtubeUrl: ytResult.url });
    return { success: true, youtubeUrl: ytResult.url };
  }
}

// Type definitions
interface AssetMeta {
  name?: string;
  type?: string;
  instructions?: string[];
  safetyWarnings?: string[];
  proTips?: string[];
  commonMistakes?: string[];
}

// Export singleton instance
export const videoOrchestrator = new VideoOrchestrator();
