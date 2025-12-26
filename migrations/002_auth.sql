-- Auth & token tabloları
ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_hash text NOT NULL DEFAULT '';

ALTER TABLE users
ADD COLUMN IF NOT EXISTS username text UNIQUE;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

