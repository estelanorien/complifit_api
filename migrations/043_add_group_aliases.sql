-- Add original_name and language to cached_asset_meta
-- This allows us to track the localized request that generated a canonical asset group
ALTER TABLE cached_asset_meta
ADD COLUMN IF NOT EXISTS original_name text;

ALTER TABLE cached_asset_meta
ADD COLUMN IF NOT EXISTS language text;

-- Index for searching by original name (aliases)
CREATE INDEX IF NOT EXISTS idx_cached_asset_meta_original_name ON cached_asset_meta (original_name)
WHERE
    original_name IS NOT NULL;