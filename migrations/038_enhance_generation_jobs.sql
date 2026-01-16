-- Add columns to generation_jobs for bulletproof queue implementation
-- Adds: job_key (deduplication), priority, started_at, expires_at
-- Add job_key for deduplication (unique canonical key like "MAIN_IMAGE_movement_bench_press_atlas")
ALTER TABLE generation_jobs
ADD COLUMN IF NOT EXISTS job_key VARCHAR(255);

-- Create unique index on job_key for pending/processing jobs only (allows duplicates for completed/failed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_job_key_active ON generation_jobs (job_key)
WHERE
    status IN ('PENDING', 'PROCESSING');

-- Add priority column (3=HIGH, 2=MEDIUM, 1=LOW)
ALTER TABLE generation_jobs
ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1;

-- Add started_at for heartbeat/timeout detection
ALTER TABLE generation_jobs
ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- Add expires_at for TTL (default 1 hour from creation)
ALTER TABLE generation_jobs
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Update expires_at default for new rows
-- Note: Can't add DEFAULT with expression on existing column, so we set it in application code
-- Add composite index for worker query efficiency
CREATE INDEX IF NOT EXISTS idx_generation_jobs_worker_query ON generation_jobs (status, priority DESC, created_at ASC);

-- Drop old simple status index if exists (replaced by composite)
DROP INDEX IF EXISTS idx_jobs_status;