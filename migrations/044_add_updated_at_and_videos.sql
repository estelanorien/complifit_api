-- Add updated_at columns to critical tables if missing
-- Fixes job failures for generation_jobs

ALTER TABLE cached_assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Ensure meals have video columns (Schema Sync)
ALTER TABLE meals ADD COLUMN IF NOT EXISTS video_main text;
ALTER TABLE meals ADD COLUMN IF NOT EXISTS step_videos jsonb DEFAULT '{}'::jsonb;
