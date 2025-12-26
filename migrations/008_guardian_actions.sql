-- Logs Guardian AI analyses & remedies
CREATE TABLE IF NOT EXISTS guardian_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type text NOT NULL, -- 'analysis' | 'remedy'
    item_type text,
    item_title text,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guardian_actions_user ON guardian_actions(user_id, created_at DESC);


