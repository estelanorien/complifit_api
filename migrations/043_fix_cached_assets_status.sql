-- Add 'generating' to the status check constraint for cached_assets
ALTER TABLE cached_assets
DROP CONSTRAINT IF EXISTS cached_assets_status_check;

ALTER TABLE cached_assets ADD CONSTRAINT cached_assets_status_check CHECK (
    status IN (
        'active',
        'draft',
        'auto',
        'generating',
        'rejected'
    )
);