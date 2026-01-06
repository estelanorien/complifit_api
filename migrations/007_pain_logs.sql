-- Tracks daily rehab check-ins / pain logs
CREATE TABLE IF NOT EXISTS pain_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pain_level int NOT NULL,
    mobility_status text,
    recovery_phase text,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pain_logs_user ON pain_logs(user_id, created_at DESC);


