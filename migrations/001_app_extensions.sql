-- Ek tablo ve görünümler (Supabase yerine lokal Postgres için)
-- testdb.sql sonrası uygulanacak ekler
-- Çalıştırma: psql -d <dbname> -f 001_app_extensions.sql

-- Kullanıcı profilleri ve sağlık/metrik verileri
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    profile_data        jsonb,
    health_metrics      jsonb,
    food_log            jsonb,
    exercise_log        jsonb,
    plan_completion_log jsonb,
    extra_exercise_log  jsonb,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Lokasyon / restoran / menü
CREATE TABLE IF NOT EXISTS restaurants (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    place_id      text,
    name          text NOT NULL,
    location_data jsonb,
    tier          text CHECK (tier IN ('partner', 'verified_crowd', 'public')),
    cuisine       text[],
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurants_place_id ON restaurants(place_id);

CREATE TABLE IF NOT EXISTS menu_items (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id    uuid REFERENCES restaurants(id) ON DELETE CASCADE,
    name             text NOT NULL,
    description      text,
    price            numeric(10,2),
    estimated_macros jsonb,
    allergens        text[],
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id);

CREATE TABLE IF NOT EXISTS menu_scans (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contributor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    restaurant_id  uuid REFERENCES restaurants(id) ON DELETE SET NULL,
    image_url      text,
    status         text CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    timestamp      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menu_scans_restaurant ON menu_scans(restaurant_id);

-- Challenge / oyun ögeleri
CREATE TABLE IF NOT EXISTS challenges (
    id            text PRIMARY KEY,
    title         text NOT NULL,
    description   text,
    type          text CHECK (type IN ('workouts', 'distance', 'calories')),
    target        int,
    duration_days int,
    xp_reward     int,
    participants  int DEFAULT 0,
    is_active     boolean DEFAULT true,
    image         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_items (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    description   text,
    type          text CHECK (type IN ('food', 'utility')),
    rarity        text CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')) DEFAULT 'common',
    is_consumable boolean DEFAULT true,
    cost          jsonb,
    effect        jsonb,
    icon          text,
    visual_key    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Sosyal ve mesajlaşma
CREATE TABLE IF NOT EXISTS social_posts (
    id           text PRIMARY KEY,
    user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    user_name    text,
    user_avatar  text,
    type         text CHECK (type IN ('text', 'image', 'video', 'flex_workout')),
    caption      text,
    media_url    text,
    timestamp    timestamptz NOT NULL DEFAULT now(),
    likes        text[] DEFAULT '{}',
    comments     int DEFAULT 0,
    flex_data    jsonb,
    safety_score int,
    visibility   text CHECK (visibility IN ('public', 'friends')) DEFAULT 'public'
);
CREATE INDEX IF NOT EXISTS idx_social_posts_ts ON social_posts(timestamp DESC);

CREATE TABLE IF NOT EXISTS messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id text NOT NULL,
    sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    content         text,
    timestamp       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);

CREATE TABLE IF NOT EXISTS moderation_queue (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_id         text NOT NULL,
    target_type       text CHECK (target_type IN ('post', 'message', 'user')),
    reason            text,
    reporter_comment  text,
    reporter_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    content           jsonb,
    status            text CHECK (status IN ('pending', 'resolved')) DEFAULT 'pending',
    timestamp         timestamptz NOT NULL DEFAULT now(),
    resolution_action text,
    ai_analysis       text
);
CREATE INDEX IF NOT EXISTS idx_moderation_queue_status ON moderation_queue(status, timestamp);

-- Önbelleklenen varlıklar (görsel/json)
CREATE TABLE IF NOT EXISTS cached_assets (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    asset_type text CHECK (asset_type IN ('image', 'video', 'json')) DEFAULT 'json',
    status     text CHECK (status IN ('active', 'draft', 'auto')) DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now()
);


