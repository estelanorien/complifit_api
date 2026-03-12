-- Step-based video: one 8s clip per instruction step, stitched in order. Director angles still apply per step.

ALTER TABLE video_source_clips
  ADD COLUMN IF NOT EXISTS step_index INTEGER;

-- One clip per (asset, coach, step). step_index NULL = legacy angle-based row (one per shot_type).
DROP INDEX IF EXISTS idx_video_source_clips_parent_coach_shot;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_source_clips_parent_coach_step
  ON video_source_clips (parent_id, coach_id, step_index);

COMMENT ON COLUMN video_source_clips.step_index IS 'Step index (0-based). NULL = legacy angle-based clip. One 8s clip per step for final stitch.';
