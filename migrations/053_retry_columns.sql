-- Migration 053: Add Retry Tracking Columns
-- Purpose: Track retry attempts and identity verification across job tables

-- Add retry columns to generation_jobs
ALTER TABLE generation_jobs
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS identity_confidence NUMERIC(3,2);

-- Add retry columns to video_jobs
ALTER TABLE video_jobs
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Add retry columns to translation_jobs
ALTER TABLE translation_jobs
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Create index for finding jobs that need retry
CREATE INDEX IF NOT EXISTS idx_generation_jobs_retry
ON generation_jobs(status, retry_count)
WHERE status = 'FAILED' AND retry_count < 5;

CREATE INDEX IF NOT EXISTS idx_video_jobs_retry
ON video_jobs(status, retry_count)
WHERE status = 'failed' AND retry_count < 3;

CREATE INDEX IF NOT EXISTS idx_translation_jobs_retry
ON translation_jobs(status, retry_count)
WHERE status = 'failed' AND retry_count < 5;

-- Add comments
COMMENT ON COLUMN generation_jobs.retry_count IS 'Number of retry attempts for this job';
COMMENT ON COLUMN generation_jobs.identity_verified IS 'Whether identity verification passed for coach images';
COMMENT ON COLUMN generation_jobs.identity_confidence IS 'Confidence score from identity verification (0.00-1.00)';
