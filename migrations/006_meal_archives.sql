-- Archived meal plans per user
CREATE TABLE IF NOT EXISTS meal_archives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    date_created timestamptz NOT NULL DEFAULT now(),
    plan jsonb NOT NULL,
    progress_day_index int,
    summary text
);

CREATE INDEX IF NOT EXISTS idx_meal_archives_user ON meal_archives(user_id, date_created DESC);


