-- Create generation_jobs table
CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'MEAL_PLAN', 'IMAGE', 'MEAL_DETAILS'
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
    payload JSONB NOT NULL, -- Input data (prompts, constraints)
    result JSONB, -- Output data (ids, urls, or full json)
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now (),
    updated_at TIMESTAMPTZ DEFAULT now ()
);

-- Add indices for polling performance
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs (status);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON generation_jobs (user_id);