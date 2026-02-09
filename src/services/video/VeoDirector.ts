/**
 * VeoDirector: shot list + Veo 3.1 calls per shot type. Persists to video_source_clips.
 * One scene pack (3–4 clips) per asset; reused across all languages.
 */

import { pool } from '../../infra/db/pool.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { AiService } from '../../application/services/aiService.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Probe actual video duration via ffprobe. Returns seconds (default 8). */
async function probeDuration(uri: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', uri
    ], { timeout: 15_000 });
    const data = JSON.parse(stdout);
    const dur = parseFloat(data?.format?.duration);
    return dur > 0 ? dur : 8;
  } catch {
    return 8;
  }
}

const aiService = new AiService();

/** Load coach reference image for video consistency (Atlas/Nova). */
async function getCoachRefDataUri(coachId: string | null): Promise<string | undefined> {
  if (!coachId || (coachId !== 'atlas' && coachId !== 'nova')) return undefined;
  const key = coachId === 'atlas' ? 'system_coach_atlas_ref' : 'system_coach_nova_ref';
  const asset = await AssetRepository.findByKey(key);
  if (!asset) return undefined;
  if (asset.buffer?.length) return `data:image/png;base64,${asset.buffer.toString('base64')}`;
  if (asset.value?.length) return asset.value.startsWith('data:') ? asset.value : `data:image/png;base64,${asset.value}`;
  return undefined;
}

const VIDEO_LOCATION_EXERCISE = 'Modern indoor gym, consistent set. Same environment for all fitness videos.';
const VIDEO_LOCATION_MEAL = 'Modern professional kitchen, consistent set. Same environment for all meal videos.';

export const SHOT_TYPES = ['ESTABLISHING', 'CLOSE_UP', 'OVERHEAD', 'ACTION'] as const;
export type ShotType = typeof SHOT_TYPES[number];

export interface VeoDirectorInput {
  assetKey: string;
  assetMeta: { name: string; type?: 'exercise' | 'meal'; instructions?: { instructions?: Array<string | { simple?: string; detailed?: string; instruction?: string }> } };
  coachId?: string | null;
}

export interface ClipResult {
  shotType: ShotType;
  uri: string;
  durationSeconds: number;
  id?: string;
}

function buildPrompt(shotType: ShotType, name: string, type: 'exercise' | 'meal', coachId: string | null): string {
  const isExercise = type === 'exercise';
  const coachDesc = coachId === 'atlas'
    ? 'Athletic male coach (Atlas), short hair, grey shirt'
    : coachId === 'nova'
      ? 'Athletic female coach (Nova), ponytail, green sports bra'
      : '';
  const base = isExercise
    ? `Cinematic 4k fitness shot. ${coachDesc || 'Fitness coach'}. ${VIDEO_LOCATION_EXERCISE}. Moody lighting. 8 second clip, seamless.`
    : `Cinematic food preparation shot. ${VIDEO_LOCATION_MEAL}. Gourmet 4k. 8 second clip.`;

  switch (shotType) {
    case 'ESTABLISHING':
      return isExercise
        ? `${base} Wide shot, coach demonstrates ${name} from start to finish. Full body in frame.`
        : `${base} Wide shot of ${name} preparation. Full scene.`;
    case 'CLOSE_UP':
      return isExercise
        ? `${base} Close-up of form and muscle engagement during ${name}.`
        : `${base} Close-up of ${name}, texture and detail.`;
    case 'OVERHEAD':
      return isExercise
        ? `${base} Overhead angle showing ${name} movement from above.`
        : `${base} Overhead 45° shot of ${name} preparation.`;
    case 'ACTION':
      return isExercise
        ? `${base} Action angle, dynamic movement for ${name}. Side or three-quarter view.`
        : `${base} Action shot, hands preparing ${name}.`;
    default:
      return `${base} ${name}.`;
  }
}

/**
 * Ensure scene pack exists for asset: generate 3–4 clips (one per shot type), persist to video_source_clips.
 * Returns existing clips if already present; otherwise generates and inserts.
 */
export async function ensureScenePack(input: VeoDirectorInput): Promise<ClipResult[]> {
  const { assetKey, assetMeta, coachId } = input;
  const name = assetMeta.name || assetKey.split('_').slice(1).join(' ');
  const type: 'exercise' | 'meal' = assetMeta.type === 'meal' ? 'meal' : 'exercise';

  const existing = await pool.query(
    `SELECT id, shot_type, uri, duration_seconds FROM video_source_clips
     WHERE parent_id = $1 AND (($2::text IS NULL AND coach_id IS NULL) OR coach_id = $2)`,
    [assetKey, coachId ?? null]
  );
  if (existing.rows.length >= 3) {
    return existing.rows.map((r: any) => ({
      shotType: r.shot_type as ShotType,
      uri: r.uri,
      durationSeconds: Number(r.duration_seconds) || 8,
      id: r.id
    }));
  }

  const referenceImage = await getCoachRefDataUri(coachId ?? null);
  const results: ClipResult[] = [];
  for (const shotType of SHOT_TYPES) {
    const prompt = buildPrompt(shotType, name, type, coachId ?? null);
    const uri = await aiService.generateVideo({ prompt, referenceImage });
    // Probe actual duration from Veo response metadata; fall back to 8s
    const durationSeconds = await probeDuration(uri).catch(() => 8);

    const { rows } = await pool.query(
      `INSERT INTO video_source_clips (parent_id, coach_id, shot_type, uri, duration_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (parent_id, coach_id, shot_type) DO UPDATE SET uri = EXCLUDED.uri, duration_seconds = EXCLUDED.duration_seconds
       RETURNING id`,
      [assetKey, coachId || null, shotType, uri, durationSeconds]
    );
    results.push({
      shotType,
      uri,
      durationSeconds,
      id: rows[0]?.id
    });
  }
  return results;
}

/** Normalize step text from instructions.instructions[i] (string or { simple, detailed }). */
function stepText(step: string | { simple?: string; detailed?: string; instruction?: string } | undefined): string {
  if (step == null) return '';
  if (typeof step === 'string') return step.trim();
  return (step.detailed || step.instruction || step.simple || '').trim();
}

/**
 * Ensure step-based scene pack: one 8s clip per instruction step, with director angle variety per step.
 * Persists to video_source_clips with step_index. Used for final stitch so each step is explicitly shown and narrated.
 */
export async function ensureStepScenePack(input: VeoDirectorInput): Promise<ClipResult[]> {
  const { assetKey, assetMeta, coachId } = input;
  const name = assetMeta.name || assetKey.split('_').slice(1).join(' ');
  const type: 'exercise' | 'meal' = assetMeta.type === 'meal' ? 'meal' : 'exercise';
  const rawSteps = assetMeta.instructions?.instructions ?? [];
  const steps = rawSteps.map((s: any) => stepText(s)).filter(Boolean);
  if (steps.length === 0) throw new Error('No instruction steps for step-based video');

  const existing = await pool.query(
    `SELECT id, step_index, shot_type, uri, duration_seconds FROM video_source_clips
     WHERE parent_id = $1 AND (($2::text IS NULL AND coach_id IS NULL) OR coach_id = $2) AND step_index IS NOT NULL
     ORDER BY step_index`,
    [assetKey, coachId ?? null]
  );
  const existingByStep = new Map(existing.rows.map((r: any) => [r.step_index, r]));
  const referenceImage = await getCoachRefDataUri(coachId ?? null);
  const results: ClipResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const stepDesc = steps[i];
    const shotType = SHOT_TYPES[i % SHOT_TYPES.length] as ShotType;
    const existingRow = existingByStep.get(i);
    if (existingRow?.uri) {
      results.push({
        shotType: existingRow.shot_type as ShotType,
        uri: existingRow.uri,
        durationSeconds: Number(existingRow.duration_seconds) || 8,
        id: existingRow.id
      });
      continue;
    }
    const prompt = buildStepPrompt(shotType, name, type, coachId ?? null, i + 1, stepDesc);
    const uri = await aiService.generateVideo({ prompt, referenceImage });
    const durationSeconds = await probeDuration(uri).catch(() => 8);
    const { rows } = await pool.query(
      `INSERT INTO video_source_clips (parent_id, coach_id, step_index, shot_type, uri, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (parent_id, coach_id, step_index) DO UPDATE SET shot_type = EXCLUDED.shot_type, uri = EXCLUDED.uri, duration_seconds = EXCLUDED.duration_seconds
       RETURNING id`,
      [assetKey, coachId || null, i, shotType, uri, durationSeconds]
    );
    results.push({ shotType, uri, durationSeconds, id: rows[0]?.id });
  }
  return results;
}

function buildStepPrompt(shotType: ShotType, name: string, type: 'exercise' | 'meal', coachId: string | null, stepNum: number, stepDesc: string): string {
  const isExercise = type === 'exercise';
  const coachDesc = coachId === 'atlas'
    ? 'Athletic male coach (Atlas), short hair, grey shirt'
    : coachId === 'nova'
      ? 'Athletic female coach (Nova), ponytail, green sports bra'
      : '';
  const base = isExercise
    ? `Cinematic 4k fitness shot. ${coachDesc || 'Fitness coach'}. ${VIDEO_LOCATION_EXERCISE}. Moody lighting. 8 second clip, seamless.`
    : `Cinematic food preparation shot. ${VIDEO_LOCATION_MEAL}. Gourmet 4k. 8 second clip.`;
  const stepLine = `Step ${stepNum}: ${stepDesc}. Show exactly this step.`;
  const angleLine = shotType === 'ESTABLISHING'
    ? 'Wide shot, full body in frame.'
    : shotType === 'CLOSE_UP'
      ? 'Close-up of form and detail.'
      : shotType === 'OVERHEAD'
        ? 'Overhead angle.'
        : 'Action angle, side or three-quarter view.';
  return `${base} ${stepLine} ${angleLine}`;
}

/**
 * Get clip rows for an asset (for edit list builder). Step-based: order by step_index; legacy: order by shot_type.
 */
export async function getClipsForAsset(parentId: string, coachId?: string | null): Promise<Array<{ id: string; shot_type: string; step_index?: number }>> {
  const { rows } = await pool.query(
    `SELECT id, shot_type, step_index FROM video_source_clips
     WHERE parent_id = $1 AND (($2::text IS NULL AND coach_id IS NULL) OR coach_id = $2)
     ORDER BY step_index NULLS LAST, array_position(ARRAY['ESTABLISHING','CLOSE_UP','OVERHEAD','ACTION'], shot_type)`,
    [parentId, coachId ?? null]
  );
  return rows;
}

/**
 * Get clip rows with URI for assembly. Step-based: order by step_index; legacy: order by shot_type.
 */
export async function getClipsWithUriForAsset(parentId: string, coachId?: string | null): Promise<Array<{ id: string; shot_type: string; uri: string; step_index?: number }>> {
  const { rows } = await pool.query(
    `SELECT id, shot_type, uri, step_index FROM video_source_clips
     WHERE parent_id = $1 AND (($2::text IS NULL AND coach_id IS NULL) OR coach_id = $2)
     ORDER BY step_index NULLS LAST, array_position(ARRAY['ESTABLISHING','CLOSE_UP','OVERHEAD','ACTION'], shot_type)`,
    [parentId, coachId ?? null]
  );
  return rows;
}
