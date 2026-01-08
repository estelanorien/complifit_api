CREATE TABLE IF NOT EXISTS gamification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    reward_willpower INTEGER DEFAULT 0,
    reward_badges JSONB DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT now ()
);

CREATE INDEX IF NOT EXISTS idx_gamification_log_user_id ON gamification_log (user_id);