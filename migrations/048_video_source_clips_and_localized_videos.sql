-- Phase 2: B-roll pipeline — source clips and localized finals per language

-- video_source_clips: one row per (asset, shot_type); 3–4 clips per asset
CREATE TABLE IF NOT EXISTS video_source_clips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id TEXT NOT NULL,
    coach_id VARCHAR(50),
    shot_type VARCHAR(20) NOT NULL,
    uri TEXT NOT NULL,
    duration_seconds NUMERIC(5,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_shot_type CHECK (shot_type IN ('ESTABLISHING', 'CLOSE_UP', 'OVERHEAD', 'ACTION', 'ALT_ANGLE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_source_clips_parent_shot ON video_source_clips (parent_id, shot_type);
CREATE INDEX IF NOT EXISTS idx_video_source_clips_parent ON video_source_clips (parent_id);

-- localized_videos: one row per (asset, language); final assembled video
CREATE TABLE IF NOT EXISTS localized_videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id TEXT NOT NULL,
    language_code VARCHAR(5) NOT NULL,
    youtube_id VARCHAR(30),
    youtube_url TEXT,
    gcs_path TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    verification_status VARCHAR(20) DEFAULT 'pending',
    verification_notes TEXT,
    review_status VARCHAR(30) DEFAULT 'ready_for_review',
    review_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_lv_status CHECK (status IN ('PENDING', 'PROCESSING', 'UPLOADED', 'FAILED')),
    CONSTRAINT valid_verification_status CHECK (verification_status IN ('pending', 'passed', 'failed')),
    CONSTRAINT valid_review_status CHECK (review_status IN ('ready_for_review', 'approved', 'revision_requested'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_localized_videos_parent_lang ON localized_videos (parent_id, language_code);
CREATE INDEX IF NOT EXISTS idx_localized_videos_parent ON localized_videos (parent_id);
CREATE INDEX IF NOT EXISTS idx_localized_videos_status ON localized_videos (status);
CREATE INDEX IF NOT EXISTS idx_localized_videos_verification ON localized_videos (verification_status);

COMMENT ON TABLE video_source_clips IS 'Raw Veo clips per asset (3–4 shot types). Reused across all languages.';
COMMENT ON TABLE localized_videos IS 'Final assembled voiceover video per (asset, language). Only verification_status=passed shown for review.';
