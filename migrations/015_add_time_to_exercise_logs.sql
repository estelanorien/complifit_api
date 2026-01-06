-- Add time field to exercise_logs_simple for time selection
-- First ensure the table exists (in case migration 003 wasn't run)
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

-- Add time column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'exercise_logs_simple' AND column_name = 'time'
    ) THEN
        ALTER TABLE exercise_logs_simple ADD COLUMN time text;
    END IF;
END $$;

-- Add time field to extra_exercise_logs for time selection
-- First ensure the table exists (in case migration 003 wasn't run)
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

-- Add time column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'extra_exercise_logs' AND column_name = 'time'
    ) THEN
        ALTER TABLE extra_exercise_logs ADD COLUMN time text;
    END IF;
END $$;

