-- Archived training programs per user
CREATE TABLE IF NOT EXISTS training_archives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    date_created timestamptz NOT NULL DEFAULT now(),
    program jsonb NOT NULL,
    progress_day_index int,
    summary text
);

CREATE INDEX IF NOT EXISTS idx_training_archives_user ON training_archives(user_id, date_created DESC);

CREATE TABLE IF NOT EXISTS saved_training_programs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    program jsonb NOT NULL,
    date_created timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_training_programs_user ON saved_training_programs(user_id, date_created DESC);

