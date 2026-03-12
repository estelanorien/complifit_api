/**
 * Edit list builder: TTS timepoints + cinematic rules → segment list.
 * No jump cuts: no two consecutive segments with same shot_type.
 */

export type ShotType = 'ESTABLISHING' | 'CLOSE_UP' | 'OVERHEAD' | 'ACTION' | 'ALT_ANGLE';

export interface Timepoint {
  markName?: string;
  timeSeconds?: number;
}

export interface ClipRow {
  id: string;
  shot_type: string;
  step_index?: number;
}

export interface EditSegment {
  clipId: string;
  shot_type: ShotType;
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds: number;
}

const SHOT_ORDER: ShotType[] = ['ESTABLISHING', 'CLOSE_UP', 'OVERHEAD', 'ACTION'];

/**
 * Build edit list: start with ESTABLISHING, then cycle CLOSE_UP → OVERHEAD → ACTION.
 * Segment lengths from timepoint gaps or fixed 5s. No consecutive same shot_type.
 */
export function buildEditList(
  timepoints: Timepoint[],
  clipRows: ClipRow[],
  totalDurationSeconds: number
): EditSegment[] {
  const clipByType = new Map<string, ClipRow>();
  for (const r of clipRows) {
    clipByType.set(r.shot_type, r);
  }
  const establishing = clipByType.get('ESTABLISHING');
  const closeUp = clipByType.get('CLOSE_UP');
  const overhead = clipByType.get('OVERHEAD');
  const action = clipByType.get('ACTION');
  const cycle = [closeUp, overhead, action].filter(Boolean) as ClipRow[];

  const segments: EditSegment[] = [];
  let segmentEnds = timepointsToSegmentEnds(timepoints, totalDurationSeconds, 5);
  if (segmentEnds.length > 0 && segmentEnds[segmentEnds.length - 1] < totalDurationSeconds) {
    segmentEnds = [...segmentEnds, totalDurationSeconds];
  }
  if (segmentEnds.length === 0) {
    segmentEnds = [totalDurationSeconds];
  }

  let start = 0;
  let shotIndex = 0;
  let prevShotType: string | null = null;

  for (const end of segmentEnds) {
    const durationSeconds = Math.max(0.5, end - start);
    let clip: ClipRow;
    let shotType: ShotType;
    if (segments.length === 0 && establishing) {
      clip = establishing;
      shotType = 'ESTABLISHING';
    } else {
      const c = cycle[shotIndex % cycle.length];
      clip = c;
      shotType = c.shot_type as ShotType;
      shotIndex++;
      while (shotType === prevShotType && cycle.length > 1) {
        shotIndex++;
        const next = cycle[shotIndex % cycle.length];
        shotType = next.shot_type as ShotType;
        clip = next;
      }
    }
    prevShotType = shotType;
    segments.push({
      clipId: clip.id,
      shot_type: shotType,
      startSeconds: start,
      endSeconds: end,
      durationSeconds
    });
    start = end;
  }

  return segments;
}

/**
 * Derive segment boundaries from TTS timepoints (e.g. sentence/phrase boundaries).
 * If timepoints empty or single, return fixed step (e.g. 5s) up to totalDurationSeconds.
 */
export function timepointsToSegmentEnds(
  timepoints: Timepoint[],
  totalDurationSeconds: number,
  fixedStepSeconds: number = 5
): number[] {
  if (timepoints.length >= 2) {
    const sorted = [...timepoints].sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0));
    return sorted.map(t => t.timeSeconds ?? 0).filter(t => t > 0 && t < totalDurationSeconds);
  }
  const ends: number[] = [];
  for (let t = fixedStepSeconds; t < totalDurationSeconds; t += fixedStepSeconds) ends.push(t);
  ends.push(totalDurationSeconds);
  return ends;
}

/**
 * Step-based edit list: one segment per step clip in order, aligned to narration "Step 1", "Step 2", ...
 * Duration from TTS timepoints when available (stepCount+1 boundaries); otherwise 8s per step (last padded to total).
 */
export function buildStepBasedEditList(
  timepoints: Timepoint[],
  clipRows: ClipRow[],
  totalDurationSeconds: number
): EditSegment[] {
  const stepCount = clipRows.length;
  if (stepCount === 0) return [];

  const sorted = [...timepoints].filter(t => t.timeSeconds != null).sort((a, b) => (a.timeSeconds ?? 0) - (b.timeSeconds ?? 0));
  const times = sorted.map(t => t.timeSeconds ?? 0);
  const useTimepoints = times.length >= stepCount + 1;

  const segments: EditSegment[] = [];
  let start = 0;
  const defaultDuration = 8;
  for (let i = 0; i < stepCount; i++) {
    const clip = clipRows[i];
    let durationSeconds: number;
    if (useTimepoints && i + 1 < times.length) {
      const end = Math.min(times[i + 1], totalDurationSeconds);
      durationSeconds = Math.max(0.5, end - start);
      start = end;
    } else {
      const remainingSteps = stepCount - i;
      const remainingTime = totalDurationSeconds - start;
      durationSeconds = remainingSteps === 1 ? Math.max(0.5, remainingTime) : defaultDuration;
      start += durationSeconds;
    }
    segments.push({
      clipId: clip.id,
      shot_type: clip.shot_type as ShotType,
      durationSeconds
    });
  }
  return segments;
}
