-- Migration: Delete exercise step images with text overlay (bad prompt images)
-- These images were generated with the old prompt that included instruction text
-- They need to be deleted so they can be regenerated with the new clean prompt
-- Delete all exercise step images (movement_*_step_*) to force regeneration
DELETE FROM assets
WHERE
    asset_type = 'image'
    AND key LIKE 'movement_%_step_%';

-- Also delete the associated metadata
DELETE FROM assets
WHERE
    asset_type = 'json'
    AND key LIKE 'movement_%_step_%_meta';

-- Note: Main exercise images (movement_*_main) are kept as they don't have text issues