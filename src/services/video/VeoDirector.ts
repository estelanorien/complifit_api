/**
 * VeoDirector: shot list + Veo 3.1 calls per shot type. Persists to video_source_clips.
 * One scene pack (3–4 clips) per asset; reused across all languages.
 */

import { pool } from '../../infra/db/pool.js';
import { AssetRepository } from '../../infra/db/repositories/AssetRepository.js';
import { AiService } from '../../application/services/aiService.js';

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
  assetMeta: { name: string; type?: 'exercise' | 'meal' };
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
    `SELECT id, shot_type, uri, duration_seconds FROM video_source_clips WHERE parent_id = $1`,
    [assetKey]
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
    const durationSeconds = 8;

    const { rows } = await pool.query(
      `INSERT INTO video_source_clips (parent_id, coach_id, shot_type, uri, duration_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (parent_id, shot_type) DO UPDATE SET uri = EXCLUDED.uri, duration_seconds = EXCLUDED.duration_seconds
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

/**
 * Get clip rows for an asset (for edit list builder).
 */
export async function getClipsForAsset(parentId: string): Promise<Array<{ id: string; shot_type: string }>> {
  const { rows } = await pool.query(
    `SELECT id, shot_type FROM video_source_clips WHERE parent_id = $1 ORDER BY array_position(ARRAY['ESTABLISHING','CLOSE_UP','OVERHEAD','ACTION'], shot_type)`,
    [parentId]
  );
  return rows;
}

/**
 * Get clip rows with URI for assembly.
 */
export async function getClipsWithUriForAsset(parentId: string): Promise<Array<{ id: string; shot_type: string; uri: string }>> {
  const { rows } = await pool.query(
    `SELECT id, shot_type, uri FROM video_source_clips WHERE parent_id = $1 ORDER BY array_position(ARRAY['ESTABLISHING','CLOSE_UP','OVERHEAD','ACTION'], shot_type)`,
    [parentId]
  );
  return rows;
}
