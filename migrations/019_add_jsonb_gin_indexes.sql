-- JSONB GIN Indexes for Performance
-- Bu migration, JSONB kolonlarında yapılan query'lerin performansını artırır

BEGIN;

-- user_profiles tablosu için GIN index'ler
-- profile_data en çok kullanılan JSONB kolonu
CREATE INDEX IF NOT EXISTS idx_user_profiles_profile_data_gin 
ON user_profiles USING GIN (profile_data);

-- health_metrics için
CREATE INDEX IF NOT EXISTS idx_user_profiles_health_metrics_gin 
ON user_profiles USING GIN (health_metrics);

-- food_logs_simple tablosu için
-- metadata kolonunda query yapılıyor
CREATE INDEX IF NOT EXISTS idx_food_logs_metadata_gin 
ON food_logs_simple USING GIN (metadata);

-- exercise_logs_simple tablosu için
-- verification ve sets kolonları JSONB
CREATE INDEX IF NOT EXISTS idx_exercise_logs_verification_gin 
ON exercise_logs_simple USING GIN (verification);

CREATE INDEX IF NOT EXISTS idx_exercise_logs_sets_gin 
ON exercise_logs_simple USING GIN (sets);

-- extra_exercise_logs tablosu için
CREATE INDEX IF NOT EXISTS idx_extra_exercise_logs_verification_gin 
ON extra_exercise_logs USING GIN (verification);

CREATE INDEX IF NOT EXISTS idx_extra_exercise_logs_sets_gin 
ON extra_exercise_logs USING GIN (sets);

-- calorie_transactions tablosu için
-- impact kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_calorie_transactions_impact_gin 
ON calorie_transactions USING GIN (impact);

-- guardian_actions tablosu için
-- payload kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_guardian_actions_payload_gin 
ON guardian_actions USING GIN (payload);

-- training_exercises tablosu için
-- metadata kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_training_exercises_metadata_gin 
ON training_exercises USING GIN (metadata);

-- meals tablosu için
-- macros, ingredients, instructions, metadata kolonları JSONB
CREATE INDEX IF NOT EXISTS idx_meals_macros_gin 
ON meals USING GIN (macros);

CREATE INDEX IF NOT EXISTS idx_meals_ingredients_gin 
ON meals USING GIN (ingredients);

CREATE INDEX IF NOT EXISTS idx_meals_instructions_gin 
ON meals USING GIN (instructions);

CREATE INDEX IF NOT EXISTS idx_meals_metadata_gin 
ON meals USING GIN (metadata);

-- menu_items tablosu için
-- estimated_macros kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_menu_items_estimated_macros_gin 
ON menu_items USING GIN (estimated_macros);

-- restaurants tablosu için
-- location_data kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_restaurants_location_data_gin 
ON restaurants USING GIN (location_data);

-- inventory_transactions tablosu için
-- cost ve metadata kolonları JSONB
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_cost_gin 
ON inventory_transactions USING GIN (cost);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_metadata_gin 
ON inventory_transactions USING GIN (metadata);

-- system_messages tablosu için
-- payload kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_system_messages_payload_gin 
ON system_messages USING GIN (payload);

-- moderation_queue tablosu için
-- content kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_moderation_queue_content_gin 
ON moderation_queue USING GIN (content);

COMMIT;

