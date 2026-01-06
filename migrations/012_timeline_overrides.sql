-- Timeline overrides, skips and wake events
CREATE TABLE IF NOT EXISTS timeline_modifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    timeline_item_id uuid REFERENCES timeline_items(id) ON DELETE SET NULL,
    day date NOT NULL,
    action text NOT NULL,
    previous_data jsonb,
    new_data jsonb,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_mods_user_day
    ON timeline_modifications (user_id, day DESC);

CREATE TABLE IF NOT EXISTS wake_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_date date NOT NULL,
    planned_time text NOT NULL,
    detected_time text,
    source text DEFAULT 'manual',
    notes text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wake_events_user_date
    ON wake_events (user_id, event_date);


