-- Migration 054: Pipeline Status Tracking
-- Purpose: Track unified generation pipeline status per entity

CREATE TABLE IF NOT EXISTS pipeline_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_key TEXT UNIQUE NOT NULL,            -- Normalized key: 'ex:bench_press' or 'meal:chicken_breast'
    entity_type VARCHAR(10) NOT NULL,           -- 'ex' or 'meal'
    entity_name TEXT,                           -- Human readable name

    -- Stage statuses: 'pending', 'running', 'completed', 'failed', 'skipped'
    meta_status VARCHAR(20) DEFAULT 'pending',
    images_atlas_status VARCHAR(20) DEFAULT 'pending',
    images_nova_status VARCHAR(20) DEFAULT 'pending',
    images_mannequin_status VARCHAR(20) DEFAULT 'pending',  -- For meals
    video_status VARCHAR(20) DEFAULT 'pending',
    translation_status VARCHAR(20) DEFAULT 'pending',

    -- Counts for tracking progress
    images_atlas_count INTEGER DEFAULT 0,       -- Number of atlas images generated
    images_nova_count INTEGER DEFAULT 0,        -- Number of nova images generated
    images_mannequin_count INTEGER DEFAULT 0,   -- Number of mannequin images (meals)
    step_count INTEGER DEFAULT 0,               -- Total steps in instructions
    translations_queued INTEGER DEFAULT 0,      -- Translations queued
    translations_completed INTEGER DEFAULT 0,   -- Translations completed

    -- Error tracking
    last_error TEXT,
    failed_stage VARCHAR(50),                   -- Which stage failed

    -- Trigger info
    triggered_by VARCHAR(20),                   -- 'user', 'admin', 'system', 'batch'
    triggered_by_user_id UUID,                  -- User who triggered (if applicable)

    -- Timestamps
    started_at TIMESTAMPTZ,
    meta_completed_at TIMESTAMPTZ,
    images_completed_at TIMESTAMPTZ,
    videos_completed_at TIMESTAMPTZ,
    translations_completed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,                   -- When all stages done
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT valid_entity_type CHECK (entity_type IN ('ex', 'meal')),
    CONSTRAINT valid_meta_status CHECK (meta_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    CONSTRAINT valid_images_atlas_status CHECK (images_atlas_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    CONSTRAINT valid_images_nova_status CHECK (images_nova_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    CONSTRAINT valid_images_mannequin_status CHECK (images_mannequin_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    CONSTRAINT valid_video_status CHECK (video_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    CONSTRAINT valid_translation_status CHECK (translation_status IN ('pending', 'running', 'completed', 'failed', 'skipped'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_pipeline_status_entity ON pipeline_status(entity_key);
CREATE INDEX IF NOT EXISTS idx_pipeline_status_type ON pipeline_status(entity_type);
CREATE INDEX IF NOT EXISTS idx_pipeline_status_incomplete ON pipeline_status(entity_type, created_at)
    WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_status_failed ON pipeline_status(failed_stage, created_at)
    WHERE failed_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_status_running ON pipeline_status(started_at)
    WHERE completed_at IS NULL AND started_at IS NOT NULL;

-- Identity verification log for debugging
CREATE TABLE IF NOT EXISTS identity_verification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_key TEXT NOT NULL,                    -- Asset that was verified
    persona VARCHAR(20) NOT NULL,               -- 'atlas' or 'nova'
    reference_key TEXT NOT NULL,                -- Reference image key used

    matches BOOLEAN NOT NULL,                   -- Did verification pass?
    confidence NUMERIC(3,2),                    -- Confidence score 0.00-1.00
    issues JSONB DEFAULT '[]'::jsonb,           -- Array of detected issues

    -- Debug info
    generated_image_hash TEXT,                  -- MD5 hash for debugging
    prompt_used TEXT,                           -- Prompt that generated the image
    attempt_number INTEGER DEFAULT 1,           -- Which generation attempt

    verified_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identity_verification_asset ON identity_verification_log(asset_key);
CREATE INDEX IF NOT EXISTS idx_identity_verification_failures ON identity_verification_log(persona, matches)
    WHERE matches = false;
CREATE INDEX IF NOT EXISTS idx_identity_verification_recent ON identity_verification_log(verified_at DESC);

-- Add comments
COMMENT ON TABLE pipeline_status IS 'Tracks unified generation pipeline status per exercise/meal entity';
COMMENT ON TABLE identity_verification_log IS 'Logs identity verification results for Atlas/Nova images for debugging';
