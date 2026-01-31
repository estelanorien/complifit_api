-- Standardize exercises to English-only in admin/API: one canonical row per logical exercise.
-- Duplicate localized rows (e.g. Yoga Akışı, Yoga (akış)) are marked non-canonical and hidden from lists.

ALTER TABLE training_exercises
  ADD COLUMN IF NOT EXISTS is_canonical boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_training_exercises_is_canonical
  ON training_exercises (is_canonical)
  WHERE is_canonical = true;

COMMENT ON COLUMN training_exercises.is_canonical IS 'If true, this row is the single English canonical entry for admin/API; duplicates (localized names) have false.';
