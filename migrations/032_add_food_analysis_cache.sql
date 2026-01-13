-- Migration: Add food_analysis_cache table
-- Previously defined inline in ai.ts, now properly migrated
CREATE TABLE IF NOT EXISTS food_analysis_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    image_hash TEXT UNIQUE NOT NULL,
    analysis JSONB NOT NULL,
    created_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        accessed_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW ()
);

-- Index for faster hash lookups
CREATE INDEX IF NOT EXISTS idx_food_analysis_cache_hash ON food_analysis_cache (image_hash);

-- Index for cleanup of old entries
CREATE INDEX IF NOT EXISTS idx_food_analysis_cache_accessed ON food_analysis_cache (accessed_at);