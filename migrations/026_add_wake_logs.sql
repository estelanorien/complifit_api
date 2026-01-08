-- Add rescheduling columns to wake_events table for smart wake functionality
ALTER TABLE wake_events
ADD COLUMN IF NOT EXISTS delay_minutes int DEFAULT 0,
ADD COLUMN IF NOT EXISTS rescheduled_items jsonb,
ADD COLUMN IF NOT EXISTS skipped_items jsonb,
ADD COLUMN IF NOT EXISTS actual_wake_time time;

COMMENT ON COLUMN wake_events.delay_minutes IS 'Minutes between planned and actual wake time';

COMMENT ON COLUMN wake_events.rescheduled_items IS 'Items that were rescheduled to later times';

COMMENT ON COLUMN wake_events.skipped_items IS 'Items that could not fit and were skipped';

COMMENT ON COLUMN wake_events.actual_wake_time IS 'Actual time user confirmed waking up';