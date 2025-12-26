-- Add biometric columns to user_profiles table
-- These columns will store age, gender, height, and weight for easier querying
-- Values will be synced from profile_data JSONB

-- Add columns one by one to avoid permission issues
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'age') THEN
        ALTER TABLE user_profiles ADD COLUMN age INTEGER;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'gender') THEN
        ALTER TABLE user_profiles ADD COLUMN gender TEXT;
        ALTER TABLE user_profiles ADD CONSTRAINT check_gender CHECK (gender IN ('male', 'female', 'other') OR gender IS NULL);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'height_cm') THEN
        ALTER TABLE user_profiles ADD COLUMN height_cm INTEGER;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'weight_kg') THEN
        ALTER TABLE user_profiles ADD COLUMN weight_kg NUMERIC(6,2);
    END IF;
END $$;

-- Migrate existing data from profile_data JSONB to columns (only if columns exist)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'age') THEN
        UPDATE user_profiles
        SET 
            age = CASE WHEN profile_data->>'age' ~ '^[0-9]+$' THEN (profile_data->>'age')::INTEGER ELSE NULL END,
            gender = CASE WHEN profile_data->>'gender' IN ('male', 'female', 'other') THEN profile_data->>'gender' ELSE NULL END,
            height_cm = CASE WHEN profile_data->>'height' ~ '^[0-9]+$' THEN (profile_data->>'height')::INTEGER ELSE NULL END,
            weight_kg = CASE WHEN profile_data->>'weight' ~ '^[0-9]+\.?[0-9]*$' THEN (profile_data->>'weight')::NUMERIC ELSE NULL END
        WHERE profile_data IS NOT NULL
          AND (age IS NULL OR gender IS NULL OR height_cm IS NULL OR weight_kg IS NULL);
    END IF;
END $$;

-- Create index for common queries (only if columns exist)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'age') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_user_profiles_biometrics') THEN
            CREATE INDEX idx_user_profiles_biometrics ON user_profiles(age, gender, height_cm, weight_kg);
        END IF;
    END IF;
END $$;

