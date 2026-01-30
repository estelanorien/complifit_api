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
 * Assemble final video: concat segments (per edit list) + TTS (+ optional music). Output 1080p.
 */
export async function assemble(
  editList: EditSegmentWithUri[],
  ttsAudioBuffer: Buffer,
  outputPath: string,
  options: AssembleOptions = {}
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `assemble-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    const concatPath = path.join(tmpDir, 'concat.mp4');
    await runFfmpeg([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy',
      concatPath
    ], tmpDir);

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
