-- Behavior engine configurations & event logs
CREATE TABLE IF NOT EXISTS behavior_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config jsonb NOT NULL,
    active boolean NOT NULL DEFAULT true,
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_behavior_configs_user_active
    ON behavior_configs (user_id)
    WHERE active = true;

CREATE TABLE IF NOT EXISTS behavior_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config_id uuid REFERENCES behavior_configs(id) ON DELETE SET NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    payload jsonb,
    outcome jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_behavior_events_user_time
    ON behavior_events (user_id, created_at DESC);


