
-- 1. Add translation status tracking to cached_asset_meta
ALTER TABLE cached_asset_meta 
ADD COLUMN IF NOT EXISTS translation_status VARCHAR(20) DEFAULT 'none',
ADD COLUMN IF NOT EXISTS translation_error TEXT;

-- 2. Create Persistent Job Queue for Translations
CREATE TABLE IF NOT EXISTS translation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_key TEXT NOT NULL REFERENCES cached_assets(key) ON DELETE CASCADE,
    target_languages TEXT[] NOT NULL, -- e.g. ['es', 'fr']
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    error_log TEXT,
    
    -- Ensure efficient polling
    CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_translation_jobs_status ON translation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_translation_jobs_created_at ON translation_jobs(created_at);
