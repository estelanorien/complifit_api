-- Migration 028: Add weight logs and metabolic trend support

-- 1. Create weight_logs table
CREATE TABLE IF NOT EXISTS weight_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weight NUMERIC(6,2) NOT NULL,
    unit TEXT NOT NULL DEFAULT 'kg',
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_weight_logs_user_date ON weight_logs(user_id, date DESC);

-- 2. Add metabolic_trend column to user_profiles
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'metabolic_trend') THEN
        ALTER TABLE user_profiles ADD COLUMN metabolic_trend JSONB;
    END IF;
END $$;
