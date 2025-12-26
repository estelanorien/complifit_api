-- Add cached_asset_meta table (moved from runtime creation in assets.ts)
-- This table stores metadata about cached assets

BEGIN;

CREATE TABLE IF NOT EXISTS cached_asset_meta (
    key text PRIMARY KEY REFERENCES cached_assets(key) ON DELETE CASCADE,
    prompt text,
    mode text,
    source text,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    movement_id text,
    created_at timestamptz DEFAULT now()
);

-- Add movement_id column if table exists without it (for backward compatibility)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'cached_asset_meta' AND column_name = 'movement_id') THEN
        ALTER TABLE cached_asset_meta ADD COLUMN movement_id text;
    END IF;
END $$;

-- Create index for movement_id queries
CREATE INDEX IF NOT EXISTS idx_cached_asset_meta_movement_id 
ON cached_asset_meta(movement_id) 
WHERE movement_id IS NOT NULL;

COMMIT;

