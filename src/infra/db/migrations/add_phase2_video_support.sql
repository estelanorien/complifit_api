-- Migration: Add Phase 2 Video Pipeline Support
-- Date: 2026-02-06
-- Description: Extends video_jobs table with Phase 2 options and adds indexes

-- Add mode column to distinguish Phase 1 vs Phase 2 videos
ALTER TABLE video_jobs
ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'phase1'
CHECK (mode IN ('phase1', 'phase2'));

-- Add transition settings for Phase 2
ALTER TABLE video_jobs
ADD COLUMN IF NOT EXISTS transition_type VARCHAR(20) DEFAULT 'cut'
CHECK (transition_type IN ('cut', 'xfade'));

ALTER TABLE video_jobs
ADD COLUMN IF NOT EXISTS transition_duration NUMERIC(3,2) DEFAULT 0.30;

-- Add music URI for background music
ALTER TABLE video_jobs
ADD COLUMN IF NOT EXISTS music_uri TEXT;

-- Index for Phase 2 pending jobs (used by job processor)
CREATE INDEX IF NOT EXISTS idx_video_jobs_phase2_pending
ON video_jobs (status, mode, created_at)
WHERE mode = 'phase2' AND status = 'pending';

-- Index for video source clips by parent and coach
CREATE INDEX IF NOT EXISTS idx_video_source_clips_parent_coach
ON video_source_clips (parent_id, coach_id);

-- Index for localized videos pending review
CREATE INDEX IF NOT EXISTS idx_localized_videos_pending_review
ON localized_videos (review_status, created_at)
WHERE review_status = 'ready_for_review';

-- Index for localized videos by verification status
CREATE INDEX IF NOT EXISTS idx_localized_videos_verification
ON localized_videos (verification_status);

-- Add duration field to localized_videos if not exists
ALTER TABLE localized_videos
ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(6,2);

-- Add verification_checked_at for tracking when verification ran
ALTER TABLE localized_videos
ADD COLUMN IF NOT EXISTS verification_checked_at TIMESTAMPTZ;

-- Comments
COMMENT ON COLUMN video_jobs.mode IS 'phase1: single 8s clip, phase2: multi-clip 45-60s assembly';
COMMENT ON COLUMN video_jobs.transition_type IS 'cut: hard cuts, xfade: cross-dissolve transitions';
COMMENT ON COLUMN video_jobs.transition_duration IS 'Transition duration in seconds (only for xfade)';
COMMENT ON COLUMN video_jobs.music_uri IS 'Optional background music URI (GCS or HTTPS)';
