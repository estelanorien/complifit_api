-- Migration: Add content_translations table for AI content caching
-- 027_add_content_translations.sql
CREATE TABLE IF NOT EXISTS content_translations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    original_text TEXT NOT NULL,
    language VARCHAR(10) NOT NULL,
    translated_text TEXT NOT NULL,
    category VARCHAR(50),
    created_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        UNIQUE (original_text, language)
);

-- Index for fast lookup by original text and language
CREATE INDEX IF NOT EXISTS idx_translations_original ON content_translations (original_text, language);

-- Optional: Index for category-based lookups
CREATE INDEX IF NOT EXISTS idx_translations_category ON content_translations (category);

COMMENT ON TABLE content_translations IS 'Caches AI-generated translations (meals, exercises) to reduce LLM costs.';