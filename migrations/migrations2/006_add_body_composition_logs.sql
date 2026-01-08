-- Body Composition Analysis Logs
-- Tracks user body composition scans over time for progress tracking
CREATE TABLE IF NOT EXISTS body_composition_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    estimated_bf DECIMAL(5, 2),
    body_type VARCHAR(50),
    analysis JSONB,
    created_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW ()
);

-- Index for querying user history
CREATE INDEX IF NOT EXISTS idx_body_composition_user_date ON body_composition_logs (user_id, created_at DESC);