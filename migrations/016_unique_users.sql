-- Ensure unique email (case-sensitive; adjust to citext if needed)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_email_unique'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_email_unique UNIQUE (email);
    END IF;
END
$$;


