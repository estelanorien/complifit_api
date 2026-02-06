/**
 * VideoAssemblyService: concat clips per edit list + TTS (+ optional music) → 1080p MP4.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAudioDurationSeconds } from './ffmpegAssembler.js';

const SAFE_URI_PREFIX = /^https?:\/\//i;
const MUSIC_VOLUME = 0.15;

export interface EditSegmentWithUri {
  clipId: string;
  shot_type: string;
  durationSeconds: number;
  uri: string;
}

export interface AssembleOptions {
  musicUri?: string;
  transitionType?: 'cut' | 'xfade';
  transitionDuration?: number; // seconds, default 0.3
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
  const tmp = path.join(os.tmpdir(), `vass-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/**
 * Assemble video-only (no TTS): concat segments per edit list → 1080p MP4. Used for director-cut (multiple angles stitched).
 */
export async function assembleVideoOnly(
  editList: EditSegmentWithUri[],
  outputPath: string
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `assemble-vo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const segPaths: string[] = [];
    for (let i = 0; i < editList.length; i++) {
      const seg = editList[i];
      const local = await downloadToTemp(seg.uri, `.mp4`);
      const outSeg = path.join(tmpDir, `seg_${i}.mp4`);
      await runFfmpeg([
        '-i', local,
        '-t', String(seg.durationSeconds),
        '-c:v', 'libx264', '-an', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
        outSeg
      ], tmpDir);
      segPaths.push(outSeg);
      try { fs.unlinkSync(local); } catch (_) {}
    }

    const listPath = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listPath, segPaths.map(p => `file '${path.basename(p)}'`).join('\n'), 'utf8');

    await runFfmpeg([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:v', 'libx264', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      '-an',
      outputPath
    ], tmpDir);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Assemble final video: concat segments (per edit list) + TTS (+ optional music). Output 1080p.
 * Supports optional xfade transitions between clips.
 */
export async function assemble(
  editList: EditSegmentWithUri[],
  ttsAudioBuffer: Buffer,
  outputPath: string,
  options: AssembleOptions = {}
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `assemble-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const useXfade = options.transitionType === 'xfade' && editList.length > 1;
  const xfadeDuration = options.transitionDuration || 0.3;

  try {
    const segPaths: string[] = [];
    for (let i = 0; i < editList.length; i++) {
      const seg = editList[i];
      const local = await downloadToTemp(seg.uri, `.mp4`);
      const outSeg = path.join(tmpDir, `seg_${i}.mp4`);
      await runFfmpeg([
        '-i', local,
        '-t', String(seg.durationSeconds),
        '-c:v', 'libx264', '-an', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
        outSeg
      ], tmpDir);
      segPaths.push(outSeg);
      try { fs.unlinkSync(local); } catch (_) {}
    }

    const concatPath = path.join(tmpDir, 'concat.mp4');

    if (useXfade && segPaths.length > 1) {
      // Build xfade filter chain for smooth transitions
      await assembleWithXfade(segPaths, concatPath, editList, xfadeDuration, tmpDir);
    } else {
      // Simple concatenation (hard cuts)
      const listPath = path.join(tmpDir, 'list.txt');
      fs.writeFileSync(listPath, segPaths.map(p => `file '${path.basename(p)}'`).join('\n'), 'utf8');
      await runFfmpeg([
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy',
        concatPath
      ], tmpDir);
    }

    const ttsPath = path.join(tmpDir, 'tts.mp3');
    fs.writeFileSync(ttsPath, ttsAudioBuffer);

    let finalAudioPath = ttsPath;
    if (options.musicUri && SAFE_URI_PREFIX.test(options.musicUri)) {
      const mixedPath = path.join(tmpDir, 'mixed.mp3');
      const durationSec = await getAudioDurationSeconds(ttsPath);
      const ext = path.extname(new URL(options.musicUri).pathname) || '.mp3';
      const musicPath = await downloadToTemp(options.musicUri, ext);
      const filter = `[1:a]aloop=loop=-1:size=2e+09,atrim=0:${durationSec},volume=${MUSIC_VOLUME}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0`;
      await runFfmpeg([
        '-i', ttsPath, '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex', filter, '-t', String(durationSec), '-ac', '1', mixedPath
      ], tmpDir);
      finalAudioPath = mixedPath;
    }

    await runFfmpeg([
      '-i', concatPath, '-i', finalAudioPath,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac',
      '-shortest', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
      outputPath
    ], tmpDir);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Assemble clips with xfade (cross-dissolve) transitions between them.
 * Creates smooth, professional transitions instead of hard cuts.
 */
async function assembleWithXfade(
  segPaths: string[],
  outputPath: string,
  editList: EditSegmentWithUri[],
  xfadeDuration: number,
  tmpDir: string
): Promise<void> {
  if (segPaths.length <= 1) {
    // Single clip, just copy
    fs.copyFileSync(segPaths[0], outputPath);
    return;
  }

  // Build ffmpeg inputs
  const inputs: string[] = [];
  for (const seg of segPaths) {
    inputs.push('-i', seg);
  }

  // Build xfade filter chain
  // For n clips, we need n-1 xfade filters chained together
  let filterComplex = '';
  let currentOffset = 0;

  for (let i = 0; i < segPaths.length - 1; i++) {
    const clipDuration = editList[i].durationSeconds;
    const input1 = i === 0 ? `[${i}:v]` : `[v${i}]`;
    const input2 = `[${i + 1}:v]`;
    const output = i === segPaths.length - 2 ? '[vout]' : `[v${i + 1}]`;

    // Calculate offset: when to start the transition
    // offset = cumulative duration - xfade overlap
    const offset = currentOffset + clipDuration - xfadeDuration;

    filterComplex += `${input1}${input2}xfade=transition=fade:duration=${xfadeDuration}:offset=${offset.toFixed(2)}${output}`;
    if (i < segPaths.length - 2) {
      filterComplex += ';';
    }

    // Update cumulative offset (subtract overlap for each transition)
    currentOffset = offset;
  }

  await runFfmpeg([
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    outputPath
  ], tmpDir);
}
