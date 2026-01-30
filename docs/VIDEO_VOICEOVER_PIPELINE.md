# Video Voiceover Pipeline (Phase 1)

This document describes the **Phase 1** voiceover pipeline: one Veo clip + TTS + ffmpeg merge (+ optional background music), one MP4 per (asset, language). No new DB tables in Phase 1; optional columns on `video_jobs` for voiceover jobs.

## Overview

- **Trigger:** Enqueue a video job with `withVoiceover: true` and optional `languages` (default `['en']`).
- **Flow:** Generate single 8s Veo clip → build narration script from asset meta → for each language: TTS (Google Cloud TTS v1beta1) → merge video (looped to audio length) + TTS (+ optional music) via ffmpeg → upload to YouTube (unlisted) or write to temp → store URL(s).
- **Storage:** First language URL in `video_jobs.result_url`; each language also in `cached_assets` as key `${assetKey}_video_voiceover_${lang}`.

## Script builder

- **File:** `src/application/services/scriptBuilder.ts`
- **Contract:** `buildNarrationScript(assetMeta, maxWords?)` → intro + "Step N: [instruction]" per item in `assetMeta.instructions.instructions`, capped at `maxWords` (default 200).

## TTS

- **File:** `src/services/audio/TTSClient.ts`
- **Cache key:** `hash(text)+languageCode` (in-memory; skip API if cached).
- **API:** Google Cloud Text-to-Speech v1beta1; `enableTimePointing` optional for Phase 2 edit lists.

## FFmpeg merge

- **File:** `src/services/video/ffmpegAssembler.ts`
- **Contract:** `mergeVideoAndAudio(videoUri, audioBuffer, outputPath, options?: { musicUri? })`.
- **Behavior:** Download video to temp; write TTS to temp; get audio duration via ffprobe; if `musicUri` set, download music, loop/trim to duration, mix TTS (primary) + music (fixed low level); loop video to audio length; mux and write to `outputPath`. No user-controlled paths.

## Config / env

- **VIDEO_MUSIC_TRACK_URI** (optional): When set, non-intrusive background music is mixed under voiceover (voice primary, music at fixed low level). GCS or HTTPS URL.
- **GOOGLE_APPLICATION_CREDENTIALS** (optional): Path to service account JSON for Google Cloud TTS. If unset, Application Default Credentials are used.
- **YouTube:** `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` — when set, merged MP4 is uploaded to YouTube (unlisted) and the URL is stored.

## Job payload (with voiceover)

- **Enqueue:** `videoQueue.enqueue(assetKey, persona, { withVoiceover: true, languages: ['en', 'es'] })`.
- **DB:** Run migration `047_add_video_voiceover_options.sql` to add `with_voiceover` and `languages` to `video_jobs`. If not run, enqueue with voiceover falls back to a normal video job and logs a warning.

## Verification (Phase 1)

1. Set env (GEMINI_API_KEY, TTS credentials, optional VIDEO_MUSIC_TRACK_URI, optional YouTube).
2. Run migration 047 if you want voiceover jobs.
3. Trigger a job with `withVoiceover: true`, `languages: ['en']` for one asset.
4. Check job completes; `result_url` and `cached_assets` key `${assetKey}_video_voiceover_en` contain the final URL.
5. Download or open the MP4: duration ~45–60s, one audio track (voiceover; music if configured).
6. No regression: same asset without `withVoiceover` still produces single 8s clip as before.

## Phase 2 (not yet implemented)

B-roll (scene pack + edit list + VideoAssemblyService), `video_source_clips` and `localized_videos` tables, automated verification, review workflow, and intervention jobs — see the plan in `plans/video_with_voiceover_45-60s.plan.md`.
