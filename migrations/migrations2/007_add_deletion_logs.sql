-- Create a table to log deleted accounts for security audit
CREATE TABLE IF NOT EXISTS deleted_users_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    original_user_id TEXT NOT NULL,
    email TEXT,
    deletion_reason TEXT,
    deleted_at TIMESTAMPTZ DEFAULT NOW (),
    metadata JSONB
);

-- Index for searching logs
CREATE INDEX IF NOT EXISTS idx_deleted_users_email ON deleted_users_log (email);