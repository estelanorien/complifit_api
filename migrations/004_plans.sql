-- Saved Smart Plans archive
CREATE TABLE IF NOT EXISTS saved_smart_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    date_created timestamptz NOT NULL DEFAULT now(),
    training jsonb NOT NULL,
    nutrition jsonb NOT NULL,
    progress_day_index int,
    summary text
);
CREATE INDEX IF NOT EXISTS idx_saved_smart_plans_user ON saved_smart_plans(user_id, date_created DESC);

