-- Migration 035: Add Custom Program Support
-- This migration adds support for tracking custom program usage stats

-- Add usage tracking for custom program parses to profile_data
-- No schema changes needed as we're using existing JSONB profile_data column
-- This migration is a placeholder to document the feature

-- Usage stats will be stored in profile_data.usageStats with keys like:
-- "customProgram_2026-01": count

-- Example structure in profile_data:
-- {
--   "usageStats": {
--     "customProgram_2026-01": 2
--   }
-- }

-- Verify profile_data column exists (it should from migration 001)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND column_name = 'profile_data'
    ) THEN
        RAISE EXCEPTION 'profile_data column missing from user_profiles table';
    END IF;
END $$;

-- Add index on profile_data.usageStats for faster custom program queries
CREATE INDEX IF NOT EXISTS idx_profile_usage_stats 
ON user_profiles USING gin ((profile_data -> 'usageStats'));

-- Add index on profile_data.subscriptionTier for economy checks
CREATE INDEX IF NOT EXISTS idx_profile_subscription_tier 
ON user_profiles ((profile_data ->> 'subscriptionTier'));

COMMENT ON INDEX idx_profile_usage_stats IS 'Index for custom program usage tracking';
COMMENT ON INDEX idx_profile_subscription_tier IS 'Index for subscription tier checks in custom programs';
