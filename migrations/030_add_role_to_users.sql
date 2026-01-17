-- Add role column to users table if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='role') THEN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';
        
        -- Set existing admins based on email list if needed
        UPDATE users SET role = 'admin' WHERE email IN ('mehmetcandiri@gmail.com', 'rmkocatas@gmail.com');
    END IF;
END $$;
