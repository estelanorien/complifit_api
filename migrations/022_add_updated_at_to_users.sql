-- Add updated_at column to users table for password change tracking
-- This migration is idempotent and safe to run multiple times

-- Add updated_at column if it doesn't exist
ALTER TABLE users
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Create index for updated_at for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users(updated_at);

-- Add trigger to automatically update updated_at on any change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Drop trigger if exists (for idempotency)
DROP TRIGGER IF EXISTS update_users_updated_at ON users;

-- Create trigger
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Backfill existing rows with created_at if they have one, otherwise now()
UPDATE users 
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

-- Make updated_at NOT NULL after backfilling
ALTER TABLE users
ALTER COLUMN updated_at SET NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN users.updated_at IS 'Timestamp of last update to user record, including password changes';

