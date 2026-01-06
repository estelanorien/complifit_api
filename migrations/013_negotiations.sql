-- Surplus mitigation & smart negotiation sessions
CREATE TABLE IF NOT EXISTS negotiation_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    surplus_session_id uuid REFERENCES surplus_sessions(id) ON DELETE SET NULL,
    target_type text NOT NULL,
    target_ref uuid,
    status text NOT NULL DEFAULT 'open',
    summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_negotiation_sessions_user
    ON negotiation_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS negotiation_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    negotiation_id uuid NOT NULL REFERENCES negotiation_sessions(id) ON DELETE CASCADE,
    action_type text NOT NULL,
    payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_actions_session_time
    ON negotiation_actions (negotiation_id, created_at ASC);


