-- Optional voiceover pipeline: with_voiceover flag and languages per job
ALTER TABLE video_jobs
ADD COLUMN IF NOT EXISTS with_voiceover BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS languages TEXT[] DEFAULT ARRAY['en'];

COMMENT ON COLUMN video_jobs.with_voiceover IS 'When true, run voiceover pipeline: TTS + merge + optional music per language';
COMMENT ON COLUMN video_jobs.languages IS 'Language codes for voiceover (e.g. en, es). Used when with_voiceover is true';
