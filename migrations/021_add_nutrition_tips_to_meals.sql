-- Add nutrition tips column to meals table
ALTER TABLE meals 
ADD COLUMN IF NOT EXISTS nutrition_tips jsonb;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_meals_nutrition_tips ON meals USING gin(nutrition_tips) WHERE nutrition_tips IS NOT NULL;

