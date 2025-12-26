-- Basic logging tables for food/exercise/plan completion

CREATE TABLE IF NOT EXISTS food_logs_simple (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    calories int,
    protein numeric(8,2),
    carbs numeric(8,2),
    fat numeric(8,2),
    status text,
    match_accuracy numeric(5,2),
    timestamp timestamptz NOT NULL DEFAULT now(),
    linked_plan_item_id uuid,
    image_url text,
    metadata jsonb
);
CREATE INDEX IF NOT EXISTS idx_food_logs_simple_user_ts ON food_logs_simple(user_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS exercise_logs_simple (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    date date NOT NULL,
    sets jsonb,
    location jsonb,
    estimated_calories int,
    verification jsonb,
    is_negotiated boolean DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exercise_logs_simple_user_date ON exercise_logs_simple(user_id, date DESC);

CREATE TABLE IF NOT EXISTS plan_completion_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id text,
    day_index int,
    meal_index int,
    date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_completion_user_date ON plan_completion_logs(user_id, date DESC);

CREATE TABLE IF NOT EXISTS extra_exercise_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    date date NOT NULL,
    sets jsonb,
    location jsonb,
    verification jsonb,
    estimated_calories int,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_extra_exercise_user_date ON extra_exercise_logs(user_id, date DESC);

