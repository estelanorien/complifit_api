-- Day conclusion tracking table
CREATE TABLE IF NOT EXISTS day_conclusions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date date NOT NULL,
    total_calories_consumed int DEFAULT 0,
    total_calories_burned int DEFAULT 0,
    net_balance int DEFAULT 0,
    meals_completed int DEFAULT 0,
    workouts_completed int DEFAULT 0,
    streak_count int DEFAULT 0,
    xp_earned int DEFAULT 0,
    coins_earned int DEFAULT 0,
    summary_data jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_day_conclusions_user_date ON day_conclusions(user_id, date DESC);

