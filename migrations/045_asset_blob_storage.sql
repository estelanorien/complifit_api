
-- 1. Create the binary storage table
-- using BYTEA for efficient binary storage of images/videos
CREATE TABLE IF NOT EXISTS asset_blob_storage (
    key TEXT PRIMARY KEY REFERENCES cached_assets(key) ON DELETE CASCADE,
    data BYTEA,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Add useful metadata columns to the main index (cached_assets) 
-- to support the unified deterministic system
ALTER TABLE cached_assets
ADD COLUMN IF NOT EXISTS hash TEXT, -- MD5 of the content for uniqueness checks
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb, -- Equipment, prompt used, etc.
ADD COLUMN IF NOT EXISTS generation_time_ms INTEGER;

-- 3. NOTE: TRUNCATE removed for production safety.
-- If a clean slate is needed, run manually:
-- TRUNCATE TABLE cached_asset_meta, cached_assets CASCADE;
