/**
 * VideoVerifier - Automatic Video Quality Control
 *
 * Verifies Phase 2 videos meet quality standards:
 * - Shot variety (at least 3 different angles)
 * - No jump cuts (no consecutive same shot type)
 * - Duration within range (45-60 seconds)
 * - Resolution check (1080p)
 * - Audio presence check
 */

import { spawn } from 'child_process';
import { EditSegment } from '../../application/services/editListBuilder.js';

export interface VerificationChecks {
  shotVariety: boolean;      // At least 3 different shot types
  noJumpCuts: boolean;       // No consecutive same shot type
  durationOk: boolean;       // 45-65 seconds (with tolerance)
  resolutionOk: boolean;     // 1920x1080
  hasAudio: boolean;         // Audio track present
}

export interface VerificationResult {
  passed: boolean;
  passedWithWarnings: boolean;
  duration: number;
  width: number;
  height: number;
  checks: VerificationChecks;
  notes: string;
  details?: {
    shotTypes: string[];
    uniqueShotCount: number;
    jumpCutPositions: number[];
  };
}

export class VideoVerifier {
  private readonly MIN_DURATION = 45;
  private readonly MAX_DURATION = 65; // Allow some tolerance
  private readonly TARGET_WIDTH = 1920;
  private readonly TARGET_HEIGHT = 1080;
  private readonly MIN_SHOT_VARIETY = 3;

  /**
   * Verify a video file meets quality standards
   */
  async verify(
    videoPath: string,
    editList: EditSegment[]
  ): Promise<VerificationResult> {
    // Get video metadata via ffprobe
    const probe = await this.ffprobe(videoPath);

    // Check edit list properties
    const shotTypes = editList.map(e => e.shot_type);
    const uniqueShots = new Set(shotTypes);
    const jumpCutPositions = this.findJumpCuts(editList);

    const checks: VerificationChecks = {
      shotVariety: uniqueShots.size >= this.MIN_SHOT_VARIETY,
      noJumpCuts: jumpCutPositions.length === 0,
      durationOk: probe.duration >= this.MIN_DURATION && probe.duration <= this.MAX_DURATION,
      resolutionOk: probe.width === this.TARGET_WIDTH && probe.height === this.TARGET_HEIGHT,
      hasAudio: probe.hasAudio
    };

    // Hard-fail checks: no audio or no shot variety are non-negotiable
    const hardFails = !checks.hasAudio || !checks.shotVariety;
    // Soft checks: duration slightly off (within 10%) or resolution slightly off (within 2%)
    const durationTolerant = probe.duration >= this.MIN_DURATION * 0.9 && probe.duration <= this.MAX_DURATION * 1.1;
    const resolutionTolerant = Math.abs(probe.width - this.TARGET_WIDTH) <= this.TARGET_WIDTH * 0.02
      && Math.abs(probe.height - this.TARGET_HEIGHT) <= this.TARGET_HEIGHT * 0.02;

    const allPassed = Object.values(checks).every(v => v);
    const passedWithWarnings = !hardFails && !allPassed && durationTolerant && resolutionTolerant && checks.noJumpCuts;
    const passed = allPassed || passedWithWarnings;
    const notes = this.buildNotes(checks, probe, uniqueShots.size, jumpCutPositions, passedWithWarnings);

    return {
      passed,
      passedWithWarnings,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      checks,
      notes,
      details: {
        shotTypes,
        uniqueShotCount: uniqueShots.size,
        jumpCutPositions
      }
    };
  }

  /**
   * Find positions where consecutive segments have the same shot type (jump cuts)
   */
  private findJumpCuts(editList: EditSegment[]): number[] {
    const positions: number[] = [];
    for (let i = 1; i < editList.length; i++) {
      if (editList[i].shot_type === editList[i - 1].shot_type) {
        positions.push(i);
      }
    }
    return positions;
  }

  /**
   * Build human-readable verification notes
   */
  private buildNotes(
    checks: VerificationChecks,
    probe: ProbeResult,
    uniqueShotCount: number,
    jumpCutPositions: number[],
    passedWithWarnings = false
  ): string {
    const issues: string[] = [];
    const passes: string[] = [];

    // Shot variety
    if (checks.shotVariety) {
      passes.push(`Shot variety: ${uniqueShotCount} unique angles`);
    } else {
      issues.push(`Insufficient shot variety: ${uniqueShotCount}/${this.MIN_SHOT_VARIETY} unique angles`);
    }

    // Jump cuts
    if (checks.noJumpCuts) {
      passes.push('No jump cuts detected');
    } else {
      issues.push(`Jump cuts at positions: ${jumpCutPositions.join(', ')}`);
    }

    // Duration
    if (checks.durationOk) {
      passes.push(`Duration: ${probe.duration.toFixed(1)}s`);
    } else {
      issues.push(`Duration out of range: ${probe.duration.toFixed(1)}s (expected ${this.MIN_DURATION}-${this.MAX_DURATION}s)`);
    }

    // Resolution
    if (checks.resolutionOk) {
      passes.push(`Resolution: ${probe.width}x${probe.height}`);
    } else {
      issues.push(`Wrong resolution: ${probe.width}x${probe.height} (expected ${this.TARGET_WIDTH}x${this.TARGET_HEIGHT})`);
    }

    // Audio
    if (checks.hasAudio) {
      passes.push('Audio track present');
    } else {
      issues.push('No audio track found');
    }

    if (issues.length === 0) {
      return `PASSED: ${passes.join('; ')}`;
    } else if (passedWithWarnings) {
      return `PASSED_WITH_WARNINGS: ${issues.join('; ')}. Passes: ${passes.join('; ')}`;
    } else {
      return `FAILED: ${issues.join('; ')}. Passes: ${passes.join('; ')}`;
    }
  }

  /**
   * Run ffprobe to get video metadata
   */
  private async ffprobe(videoPath: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        videoPath
      ];

      const proc = spawn('ffprobe', args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${stderr}`));
          return;
        }

        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
          const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio');

          resolve({
            duration: parseFloat(data.format?.duration || '0'),
            width: videoStream?.width || 0,
            height: videoStream?.height || 0,
            hasAudio: !!audioStream,
            codec: videoStream?.codec_name || 'unknown',
            bitrate: parseInt(data.format?.bit_rate || '0', 10)
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run ffprobe: ${err.message}`));
      });
    });
  }
}

interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec: string;
  bitrate: number;
}

// Export singleton
export const videoVerifier = new VideoVerifier();
