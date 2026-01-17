-- JSONB GIN Indexes for Performance
-- Bu migration, JSONB kolonlarında yapılan query'lerin performansını artırır
-- user_profiles tablosu için GIN index'ler
-- profile_data en çok kullanılan JSONB kolonu
CREATE INDEX IF NOT EXISTS idx_user_profiles_profile_data_gin ON user_profiles USING GIN (profile_data);

-- health_metrics için
CREATE INDEX IF NOT EXISTS idx_user_profiles_health_metrics_gin ON user_profiles USING GIN (health_metrics);

-- food_logs_simple tablosu için
-- metadata kolonunda query yapılıyor
CREATE INDEX IF NOT EXISTS idx_food_logs_metadata_gin ON food_logs_simple USING GIN (metadata);

-- exercise_logs_simple tablosu için
-- verification ve sets kolonları JSONB
CREATE INDEX IF NOT EXISTS idx_exercise_logs_verification_gin ON exercise_logs_simple USING GIN (verification);

CREATE INDEX IF NOT EXISTS idx_exercise_logs_sets_gin ON exercise_logs_simple USING GIN (sets);

-- extra_exercise_logs tablosu için
CREATE INDEX IF NOT EXISTS idx_extra_exercise_logs_verification_gin ON extra_exercise_logs USING GIN (verification);

CREATE INDEX IF NOT EXISTS idx_extra_exercise_logs_sets_gin ON extra_exercise_logs USING GIN (sets);

-- calorie_transactions tablosu için
-- impact kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_calorie_transactions_impact_gin ON calorie_transactions USING GIN (impact);

-- guardian_actions tablosu için
-- payload kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_guardian_actions_payload_gin ON guardian_actions USING GIN (payload);

-- training_exercises tablosu için
-- exercise_data kolonu JSONB - COMMENTED OUT: column doesn't exist
-- CREATE INDEX IF NOT EXISTS idx_training_exercises_exercise_data_gin 
-- ON training_exercises USING GIN (exercise_data);
-- meals tablosu için
-- meal_data kolonu JSONB (zaten 021 migration'da eklendi)
-- CREATE INDEX IF NOT EXISTS idx_meals_data_gin 
-- ON meals USING GIN (meal_data);
-- menu_items tablosu için (estimated_macros yok, sadece description vs. var)
-- Gerekirse eklenebilir
-- restaurants tablosu için (location_data yok, address, lat, lng ayrı kolonlarda)
-- Gerekirse eklenebilir
-- inventory_transactions tablosu için (cost ve metadata yok, sadece amount var)
-- Gerekirse eklenebilir
-- system_messages tablosu yok (kullanılmıyor)
-- Gerekirse eklenebilir
-- moderation_queue tablosu için
-- content kolonu JSONB
CREATE INDEX IF NOT EXISTS idx_moderation_queue_content_gin ON moderation_queue USING GIN (content);