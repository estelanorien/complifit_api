-- Add text_context and text_context_simple to cached_asset_meta
-- Required by: POST /assets/by-movement, AssetRepository, admin routes
-- Without these columns the by-movement query returns 500 (column does not exist)
ALTER TABLE cached_asset_meta
ADD COLUMN IF NOT EXISTS text_context TEXT,
ADD COLUMN IF NOT EXISTS text_context_simple TEXT;
