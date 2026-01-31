-- Scope video_source_clips by coach_id so Atlas and Nova each have their own scene pack per asset.
-- Drop old unique index (parent_id, shot_type) and add (parent_id, coach_id, shot_type).

DROP INDEX IF EXISTS idx_video_source_clips_parent_shot;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_source_clips_parent_coach_shot
  ON video_source_clips (parent_id, coach_id, shot_type);

COMMENT ON INDEX idx_video_source_clips_parent_coach_shot IS 'One clip per (asset, coach, shot type). NULL coach_id = meal.';
