-- 008_add_fcm_token.sql
DO $$ 
BEGIN
    -- Ensure 'fcm_token' column exists for Push Notifications
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='fcm_token') THEN
        ALTER TABLE profiles ADD COLUMN "fcm_token" TEXT;
    END IF;

    RAISE NOTICE 'Added fcm_token column';
END $$;
