import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Readable } from 'stream';
import { logger } from '../infra/logger.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadOptions {
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  videoUrl?: string;       // Remote URL or local file path (original interface)
  videoBuffer?: Buffer;    // Direct buffer upload
  mimeType?: string;
}

export interface UploadResult {
  success: boolean;
  videoId?: string;
  url?: string;
  error?: string;
  retryable: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// YouTubeService
// ---------------------------------------------------------------------------

export class YouTubeService {
  private oauth2Client: OAuth2Client | null = null;
  private lastValidation = 0;

  /** Re-validate credentials if older than 1 hour. */
  private static readonly VALIDATION_TTL_MS = 3_600_000;

  // -----------------------------------------------------------------------
  // Client management
  // -----------------------------------------------------------------------

  /**
   * Returns a cached OAuth2Client singleton.
   * Throws a clear error if required credentials are missing from env.
   */
  private getClient(): OAuth2Client {
    if (this.oauth2Client) {
      return this.oauth2Client;
    }

    const clientId = (env as any).youtubeClientId ?? process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = (env as any).youtubeClientSecret ?? process.env.YOUTUBE_CLIENT_SECRET;
    const refreshToken = (env as any).youtubeRefreshToken ?? process.env.YOUTUBE_REFRESH_TOKEN;

    if (!clientId || !clientSecret) {
      throw new Error(
        'YouTube OAuth2 credentials missing: YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set in environment.',
      );
    }

    if (!refreshToken) {
      throw new Error(
        'YouTube OAuth2 refresh token missing: YOUTUBE_REFRESH_TOKEN must be set in environment.',
      );
    }

    this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });

    logger.info('YouTube OAuth2 client initialised');
    return this.oauth2Client;
  }

  // -----------------------------------------------------------------------
  // Credential validation
  // -----------------------------------------------------------------------

  /**
   * Validates the current credentials by making a lightweight
   * `channels.list` call (mine=true).
   */
  async validateCredentials(): Promise<ValidationResult> {
    try {
      const auth = this.getClient();
      const youtube = google.youtube({ version: 'v3', auth });

      await youtube.channels.list({
        part: ['id'],
        mine: true,
      });

      this.lastValidation = Date.now();
      return { valid: true };
    } catch (err: any) {
      const message = err?.message ?? String(err);

      if (message.includes('invalid_grant')) {
        logger.error('YouTube credential validation failed: invalid_grant — refresh token is revoked or expired');
        return { valid: false, error: 'invalid_grant: refresh token is revoked or expired. Re-authorise the app.' };
      }

      logger.error(`YouTube credential validation failed: ${message}`);
      return { valid: false, error: message };
    }
  }

  // -----------------------------------------------------------------------
  // Upload
  // -----------------------------------------------------------------------

  /**
   * Uploads a video to YouTube.
   *
   * Performs a pre-flight credential check when the last successful
   * validation is older than `VALIDATION_TTL_MS` (1 hour).
   */
  async upload(options: UploadOptions): Promise<UploadResult> {
    const {
      title,
      description = '',
      tags = [],
      categoryId = '22', // "People & Blogs"
      privacyStatus = 'unlisted',
      videoUrl,
      videoBuffer,
      mimeType = 'video/mp4',
    } = options;

    try {
      const auth = this.getClient();

      // Pre-flight credential validation if stale
      if (Date.now() - this.lastValidation > YouTubeService.VALIDATION_TTL_MS) {
        logger.info('YouTube credentials stale — running pre-flight validation');
        const check = await this.validateCredentials();
        if (!check.valid) {
          const isInvalidGrant = check.error?.includes('invalid_grant') ?? false;
          return {
            success: false,
            error: `Pre-flight validation failed: ${check.error}`,
            retryable: !isInvalidGrant,
          };
        }
      }

      // Resolve video body from buffer, URL, or local file
      let videoBody: any;
      if (videoBuffer) {
        videoBody = Readable.from(videoBuffer);
      } else if (videoUrl) {
        if (videoUrl.startsWith('http')) {
          const { default: fetch } = await import('node-fetch');
          const response = await fetch(videoUrl);
          if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);
          videoBody = response.body;
        } else {
          const { createReadStream } = await import('fs');
          videoBody = createReadStream(videoUrl);
        }
      } else {
        return { success: false, error: 'No videoBuffer or videoUrl provided', retryable: false };
      }

      const youtube = google.youtube({ version: 'v3', auth });

      const res = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title,
            description,
            tags,
            categoryId,
          },
          status: {
            privacyStatus,
          },
        },
        media: {
          mimeType,
          body: videoBody,
        },
      });

      const videoId = res.data.id;
      if (!videoId) {
        return {
          success: false,
          error: 'Upload succeeded but no video ID was returned.',
          retryable: false,
        };
      }

      const url = `https://www.youtube.com/watch?v=${videoId}`;
      logger.info(`YouTube upload successful: ${url}`);

      this.lastValidation = Date.now();
      return { success: true, videoId, url, retryable: false };
    } catch (err: any) {
      return this.handleUploadError(err);
    }
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  /**
   * Deletes a video from YouTube by its video ID.
   */
  async deleteVideo(videoId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const auth = this.getClient();
      const youtube = google.youtube({ version: 'v3', auth });

      await youtube.videos.delete({ id: videoId });

      logger.info(`YouTube video deleted: ${videoId}`);
      return { success: true };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`YouTube video deletion failed for ${videoId}: ${message}`);
      return { success: false, error: message };
    }
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private handleUploadError(err: any): UploadResult {
    const message: string = err?.message ?? String(err);
    const code: number | undefined = err?.code ?? err?.response?.status;

    // Auth failure — not retryable
    if (message.includes('invalid_grant')) {
      logger.error('YouTube upload failed: invalid_grant — token revoked or expired');
      return {
        success: false,
        error: 'invalid_grant: refresh token is revoked or expired. Re-authorise the app.',
        retryable: false,
      };
    }

    // Quota / rate-limit — retryable
    if (code === 403 || code === 429 || message.includes('quotaExceeded') || message.includes('rateLimitExceeded')) {
      logger.warn(`YouTube upload hit rate/quota limit: ${message}`);
      return {
        success: false,
        error: `Rate or quota limit: ${message}`,
        retryable: true,
      };
    }

    // Network-level errors — retryable
    if (
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('socket hang up') ||
      code === 500 ||
      code === 502 ||
      code === 503 ||
      code === 504
    ) {
      logger.warn(`YouTube upload failed with transient error: ${message}`);
      return {
        success: false,
        error: `Network/server error: ${message}`,
        retryable: true,
      };
    }

    // Everything else — assume not retryable
    logger.error(`YouTube upload failed: ${message}`);
    const isProduction = process.env.NODE_ENV === 'production';
    return {
      success: false,
      error: isProduction ? 'YouTube upload failed' : message,
      retryable: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const youtubeService = new YouTubeService();

// ---------------------------------------------------------------------------
// Backwards-compatible named export
// ---------------------------------------------------------------------------

export const uploadToYouTube = (opts: UploadOptions): Promise<UploadResult> =>
  youtubeService.upload(opts);
