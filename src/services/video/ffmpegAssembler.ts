/**
 * FFmpeg merge: loop video to audio length, mix TTS (+ optional music).
 * Used by video-with-voiceover pipeline. No user-controlled paths.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SAFE_URI_PREFIX = /^https?:\/\//i;
const MUSIC_VOLUME = 0.15; // Non-intrusive under voice

function isSafeOutputPath(p: string): boolean {
  const normalized = path.normalize(p);
  const tmp = path.normalize(os.tmpdir());
  return normalized.startsWith(tmp) || normalized.startsWith(path.normalize(process.cwd()));
}

export function getAudioDurationSeconds(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.stderr?.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      const n = parseFloat(out.trim());
      if (code === 0 && !Number.isNaN(n) && n > 0) resolve(n);
      else reject(new Error(`ffprobe failed or invalid duration: ${out.trim()}`));
    });
    proc.on('error', reject);
  });
}

function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { cwd, stdio: 'ignore' });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    proc.on('error', reject);
  });
}

async function downloadToTemp(uri: string, suffix: string): Promise<string> {
  if (!SAFE_URI_PREFIX.test(uri)) throw new Error('Invalid URI for download');
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `video-voiceover-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

export interface MergeVideoAndAudioOptions {
  musicUri?: string;
}

/**
 * Merge video (looped to audio length) with TTS audio. Optionally mix in background music at low level.
 * videoUri: HTTPS/HTTP only. outputPath: must be under tmp or cwd.
 */
export async function mergeVideoAndAudio(
  videoUri: string,
  audioBuffer: Buffer,
  outputPath: string,
  options: MergeVideoAndAudioOptions = {}
): Promise<void> {
  if (!SAFE_URI_PREFIX.test(videoUri)) throw new Error('Invalid videoUri');
  if (!isSafeOutputPath(outputPath)) throw new Error('outputPath not in allowed directory');

  const tmpDir = path.join(os.tmpdir(), `voiceover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  let videoPath: string | null = null;

  try {
    videoPath = await downloadToTemp(videoUri, '.mp4');
    const ttsPath = path.join(tmpDir, 'tts.mp3');
    fs.writeFileSync(ttsPath, audioBuffer);

    const durationSec = await getAudioDurationSeconds(ttsPath);

    let finalAudioPath = ttsPath;
    if (options.musicUri && SAFE_URI_PREFIX.test(options.musicUri)) {
      const ext = path.extname(new URL(options.musicUri).pathname) || '.mp3';
      const musicPath = await downloadToTemp(options.musicUri, ext);
      const mixedPath = path.join(tmpDir, 'mixed.mp3');
      // Mix: TTS (0:a) primary, music (1:a) at MUSIC_VOLUME; music looped/trimmed to duration
      const filter = `[1:a]aloop=loop=-1:size=2e+09,atrim=0:${durationSec},volume=${MUSIC_VOLUME}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0`;
      await runFfmpeg([
        '-i', ttsPath,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex', filter,
        '-t', String(durationSec),
        '-ac', '1',
        mixedPath
      ], tmpDir);
      finalAudioPath = mixedPath;
    }

    // Loop video to duration, replace audio with final audio
    await runFfmpeg([
      '-stream_loop', '-1', '-i', videoPath,
      '-i', finalAudioPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-c:a', 'aac',
      '-shortest',
      '-t', String(durationSec),
      outputPath
    ], tmpDir);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    if (videoPath && fs.existsSync(videoPath)) {
      try { fs.unlinkSync(videoPath); } catch (_) {}
    }
  }
}
