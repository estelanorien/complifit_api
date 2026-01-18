
-- Migration: Add missing columns to cached_asset_meta
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cached_asset_meta' AND column_name='source') THEN
        ALTER TABLE cached_asset_meta ADD COLUMN source TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cached_asset_meta' AND column_name='movement_id') THEN
        ALTER TABLE cached_asset_meta ADD COLUMN movement_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cached_asset_meta' AND column_name='persona') THEN
        ALTER TABLE cached_asset_meta ADD COLUMN persona TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cached_asset_meta' AND column_name='step_index') THEN
        ALTER TABLE cached_asset_meta ADD COLUMN step_index INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cached_asset_meta' AND column_name='created_by') THEN
        ALTER TABLE cached_asset_meta ADD COLUMN created_by TEXT;
    END IF;
END $$;
