-- Migration 029: Add Phone Number Support
-- Add phone_number for notifications (if consented)
-- Add phone_hash for privacy-first social matching (SHA-256 of E.164)
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20),
ADD COLUMN IF NOT EXISTS phone_hash VARCHAR(64);

-- Create index on phone_hash for fast lookups during contact sync
CREATE INDEX IF NOT EXISTS idx_user_profiles_phone_hash ON user_profiles (phone_hash);