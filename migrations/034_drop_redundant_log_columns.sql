-- Drop redundant JSONB log columns from user_profiles
-- These logs are now exclusively managed in relational tables:
-- food_logs_simple, exercise_logs_simple, plan_completion_logs, extra_exercise_logs_simple

DO $$ 
BEGIN 
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_profiles' AND column_name='food_log') THEN
        ALTER TABLE user_profiles DROP COLUMN food_log;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_profiles' AND column_name='exercise_log') THEN
        ALTER TABLE user_profiles DROP COLUMN exercise_log;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_profiles' AND column_name='plan_completion_log') THEN
        ALTER TABLE user_profiles DROP COLUMN plan_completion_log;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_profiles' AND column_name='extra_exercise_log') THEN
        ALTER TABLE user_profiles DROP COLUMN extra_exercise_log;
    END IF;
END $$;
