-- Migration: Add content_hash to content_translations for robust immutable caching
-- 031_add_translation_hash.sql
ALTER TABLE content_translations
ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);

-- Create index for fast hash-based lookup
CREATE INDEX IF NOT EXISTS idx_translations_hash ON content_translations (content_hash, language);

-- Optional: Populate existing hashes (best effort)
-- We can't easily run JS hash here, so we leave existing rows with NULL hash for now.
-- New rows will have the hash.