-- 1. Add video status tracking to cached_asset_meta
ALTER TABLE cached_asset_meta
ADD COLUMN IF NOT EXISTS video_status VARCHAR(20) DEFAULT 'none',
ADD COLUMN IF NOT EXISTS video_error TEXT;

-- 2. Create Persistent Job Queue for Video Generation
CREATE TABLE IF NOT EXISTS video_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    asset_key TEXT NOT NULL REFERENCES cached_assets (key) ON DELETE CASCADE,
    persona VARCHAR(20), -- 'atlas', 'nova', or null for meals
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        updated_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        error_log TEXT,
        result_url TEXT,
        -- Ensure efficient polling
        CONSTRAINT valid_video_status CHECK (
            status IN ('pending', 'processing', 'completed', 'failed')
        )
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs (status);

CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at ON video_jobs (created_at);