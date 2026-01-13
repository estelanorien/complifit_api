-- Migration: Add password_reset_tokens table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    expires_at TIMESTAMP
    WITH
        TIME ZONE NOT NULL,
        created_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW ()
);

-- Index for token lookup
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens (token);

-- Cleanup expired tokens periodically
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens (expires_at);