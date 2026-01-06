-- Migration: Phase 1 Database Updates
-- Created: 2026-01-06
-- Description: Adds columns for Injuries, Medical Overrides, and User Schedule.

-- 1. Acute Injuries (Array of strings)
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS injuries text[] DEFAULT '{}';

-- 2. Medical Overrides (Doctor notes string)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS medical_overrides text;

-- 3. User Schedule (Wake/Sleep times)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS user_schedule jsonb DEFAULT '{}'::jsonb;

-- Optional Comments
COMMENT ON COLUMN profiles.injuries IS 'Array of acute injury codes (e.g. knee_sprain).';
COMMENT ON COLUMN profiles.medical_overrides IS 'Doctor notes manually entered to override safety checks.';
COMMENT ON COLUMN profiles.user_schedule IS 'JSON object storing wakeTime, bedTime, trainingTime.';
