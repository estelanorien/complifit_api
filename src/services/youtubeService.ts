import { google } from 'googleapis';
import { logger } from '../infra/logger.js';
import { env } from '../config/env.js';
import fs from 'fs';
import fetch from 'node-fetch';
import { Readable } from 'stream';

const youtube = google.youtube('v3');

interface UploadOptions {
    videoUrl: string; // Can be a local path or a remote URL (e.g. from generated asset)
    title: string;
    description: string;
    privacyStatus?: 'private' | 'unlisted' | 'public';
}

export const uploadToYouTube = async (options: UploadOptions) => {
    if (!env.youtube.clientId || !env.youtube.clientSecret || !env.youtube.refreshToken) {
        throw new Error("YouTube credentials missing in environment configuration.");
    }

    const oauth2Client = new google.auth.OAuth2(
        env.youtube.clientId,
        env.youtube.clientSecret,
        'https://developers.google.com/oauthplayground' // Must match console
    );

    oauth2Client.setCredentials({
        refresh_token: env.youtube.refreshToken
    });

    // 1. Get the video stream
    let videoBody: any;

    if (options.videoUrl.startsWith('http')) {
        const response = await fetch(options.videoUrl);
        if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);
        videoBody = response.body;
    } else {
        // Assume local file if not http (unlikely for this app, but good for testing)
        videoBody = fs.createReadStream(options.videoUrl);
    }

    // 2. Upload
    try {
        const response = await youtube.videos.insert({
            auth: oauth2Client,
            part: ['snippet', 'status'],
            requestBody: {
                snippet: {
                    title: options.title,
                    description: options.description,
                    tags: ['Complifit', 'Fitness', 'AI'],
                },
                status: {
                    privacyStatus: options.privacyStatus || 'private', // Safety first
                    selfDeclaredMadeForKids: false,
                },
            },
            media: {
                body: videoBody
            },
        });

        return {
            success: true,
            videoId: response.data.id,
            url: `https://youtu.be/${response.data.id}`
        };
    } catch (error: any) {
        logger.error("YouTube Upload Error", error as Error);
        throw new Error(`YouTube Upload Failed: ${error.message}`);
    }
};
