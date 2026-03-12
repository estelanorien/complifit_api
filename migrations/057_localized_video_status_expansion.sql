-- Expand localized_videos status to include granular pipeline states
ALTER TABLE localized_videos
  DROP CONSTRAINT IF EXISTS valid_lv_status;

ALTER TABLE localized_videos
  ADD CONSTRAINT valid_lv_status
  CHECK (status IN ('PENDING', 'PROCESSING', 'VERIFICATION', 'UPLOADING', 'UPLOADED', 'FAILED'));
