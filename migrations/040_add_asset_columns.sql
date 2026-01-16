-- Add explicit video columns to exercises and meals for easier app consumption
-- This aligns with the "Atlas/Nova" dual gender strategy and Meal Clips

BEGIN;

-- 1. Exercises: Add Atlas and Nova video columns
ALTER TABLE training_exercises ADD COLUMN IF NOT EXISTS video_atlas text;
ALTER TABLE training_exercises ADD COLUMN IF NOT EXISTS video_nova text;

-- 2. Meals: Add Main Video and Step Videos map
ALTER TABLE meals ADD COLUMN IF NOT EXISTS video_main text;
-- step_videos will be a JSONB object mapping step index (or partial text) to video URL
ALTER TABLE meals ADD COLUMN IF NOT EXISTS step_videos jsonb DEFAULT '{}'::jsonb;

COMMIT;
