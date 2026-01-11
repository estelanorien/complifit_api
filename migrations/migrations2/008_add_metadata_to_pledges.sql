-- 8. Add metadata to pledges for rich UI features
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_pledges' AND column_name='metadata') THEN
        ALTER TABLE user_pledges ADD COLUMN metadata JSONB DEFAULT '{}';
    END IF;
END $$;
