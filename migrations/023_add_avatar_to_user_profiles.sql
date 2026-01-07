-- Add avatar_url column to user_profiles for profile photos
-- This migration is idempotent and safe to run multiple times

-- Add avatar_url column if it doesn't exist
-- We store it as TEXT to support both URLs and base64 data URIs
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Create index for avatar_url for efficient queries (e.g., finding users with/without avatars)
CREATE INDEX IF NOT EXISTS idx_user_profiles_avatar_url ON user_profiles(avatar_url) WHERE avatar_url IS NOT NULL;

-- Migrate existing avatar data from profile_data JSONB to avatar_url column
-- This is a one-time migration for existing data
UPDATE user_profiles
SET avatar_url = profile_data->>'avatar'
WHERE profile_data->>'avatar' IS NOT NULL 
  AND avatar_url IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN user_profiles.avatar_url IS 'Profile photo URL or base64 data URI. Can be stored in cloud storage or as base64 string.';

-- Optional: Add constraint to limit avatar size if storing base64
-- Uncomment if you want to enforce a size limit (e.g., 5MB base64 = ~6.8M characters)
-- ALTER TABLE user_profiles
-- ADD CONSTRAINT check_avatar_size CHECK (
--     avatar_url IS NULL OR 
--     length(avatar_url) <= 7000000
-- );

