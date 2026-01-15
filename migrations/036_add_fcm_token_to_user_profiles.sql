-- Migration: Add fcm_token to user_profiles and migrate data
-- Date: 2026-01-15

DO $$ 
BEGIN
    -- 1. Add 'fcm_token' column to 'user_profiles' if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_profiles' AND column_name='fcm_token') THEN
        ALTER TABLE user_profiles ADD COLUMN "fcm_token" TEXT;
        RAISE NOTICE 'Added fcm_token column to user_profiles';
    END IF;

    -- 2. Migrate existing tokens from 'profiles' table (backward compatibility)
    -- This assumes both tables use the same user_id and 'profiles' might have legacy data.
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='profiles') THEN
        UPDATE user_profiles up
        SET fcm_token = p.fcm_token
        FROM profiles p
        WHERE up.user_id = p.user_id
          AND up.fcm_token IS NULL
          AND p.fcm_token IS NOT NULL;
        RAISE NOTICE 'Migrated FCM tokens from profiles to user_profiles';
    END IF;

END $$;
