-- Migration 052: Dead Letter Queue
-- Purpose: Store failed generation tasks for retry/debugging

CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_id UUID,                           -- Original job ID (if applicable)
    task_type VARCHAR(50) NOT NULL,             -- 'image', 'video', 'translation', 'pipeline'
    entity_key TEXT,                            -- Asset key or entity identifier
    payload JSONB NOT NULL DEFAULT '{}'::jsonb, -- Original task data
    error_message TEXT,                         -- Last error message
    error_stack TEXT,                           -- Error stack trace (if available)
    attempt_count INTEGER DEFAULT 0,            -- Number of attempts before dead-letter
    max_attempts INTEGER DEFAULT 5,             -- Max attempts that were configured
    first_failure_at TIMESTAMPTZ,               -- When task first failed
    last_failure_at TIMESTAMPTZ DEFAULT now(),  -- When task was moved to dead-letter
    can_retry BOOLEAN DEFAULT true,             -- Manual flag to prevent retries
    retry_after TIMESTAMPTZ,                    -- Scheduled retry time (if set)
    resolved_at TIMESTAMPTZ,                    -- When manually resolved/acknowledged
    resolved_by UUID,                           -- User who resolved (FK to users optional)
    resolution_notes TEXT,                      -- Notes about resolution
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_dead_letter_task_type ON dead_letter_queue(task_type);
CREATE INDEX IF NOT EXISTS idx_dead_letter_entity_key ON dead_letter_queue(entity_key);
CREATE INDEX IF NOT EXISTS idx_dead_letter_can_retry ON dead_letter_queue(can_retry, retry_after) WHERE can_retry = true;
CREATE INDEX IF NOT EXISTS idx_dead_letter_unresolved ON dead_letter_queue(task_type, created_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dead_letter_recent ON dead_letter_queue(created_at DESC);

-- Add comment for documentation
COMMENT ON TABLE dead_letter_queue IS 'Stores failed generation tasks that exceeded retry limits for debugging and manual retry';
