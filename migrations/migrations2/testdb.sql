-- Vitality AI Fitness - Master Migration (final)

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- Users / profiles
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name          text,
  age           int,
  gender        text,
  height_cm     int,
  weight_kg     numeric(6,2),
  primary_goal  text,
  secondary_goal text,
  dietary_pref  text,
  fitness_level text,
  workout_days_per_week int,
  conditions    text[],
  injuries      text[],
  medical_overrides text,
  user_schedule jsonb,
  equipment     text[],
  coach_settings jsonb,
  gamification   jsonb,
  stats          jsonb,
  event_mode     jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_preferences (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language      text DEFAULT 'en',
  theme         text DEFAULT 'system',
  notifications_enabled boolean DEFAULT true,
  privacy_settings jsonb DEFAULT '{"show_activity": true}',
  updated_at    timestamptz DEFAULT now()
);

CREATE TABLE user_integrations (
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  provider  text NOT NULL,
  status    text DEFAULT 'active',
  last_sync timestamptz,
  config    jsonb,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE health_metrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          date NOT NULL,
  steps         int,
  resting_hr    int,
  hrv           int,
  sleep_hours   numeric(4,2),
  active_energy int,
  detected_wake_time text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_health_metrics_user_date ON health_metrics(user_id, date);

-- Subscriptions / premium
CREATE TABLE subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id    text NOT NULL,
  status     text NOT NULL, -- active, canceled, past_due, trialing
  renews_at  timestamptz,
  cancel_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE entitlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE, -- e.g. ai_ultra, plan_history
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_entitlements (
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  entitlement_id uuid REFERENCES entitlements(id) ON DELETE CASCADE,
  source         text, -- subscription, promo, manual
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entitlement_id)
);

-- ... (previous content) ...

-- EAT OUT FEATURE TABLES (Added 2026-01-06)

CREATE TABLE restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_place_id text UNIQUE,
  name text NOT NULL,
  address text,
  lat numeric(10, 8),
  lng numeric(11, 8),
  cuisine text[],
  tier text DEFAULT 'public',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price numeric(6, 2),
  calories int,
  protein int,
  carbs int,
  fat int,
  is_verified boolean DEFAULT false,
  verification_source text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE menu_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  image_url text,
  items_found_json jsonb,
  status text DEFAULT 'pending',
  xp_awarded int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_restaurants_location ON restaurants(lat, lng);
CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX idx_menu_scans_user ON menu_scans(user_id);

-- Meal planning
CREATE TABLE IF NOT EXISTS meal_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text,
  start_date   date,
  variety_mode text,
  is_recovery  boolean DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meal_plans_user ON meal_plans(user_id);

CREATE TABLE meal_plan_days (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_id    uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day_index       int NOT NULL,
  target_calories int,
  UNIQUE (meal_plan_id, day_index)
);

CREATE TABLE meals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_plan_day_id uuid NOT NULL REFERENCES meal_plan_days(id) ON DELETE CASCADE,
  type            text NOT NULL, -- breakfast, lunch, ...
  name            text NOT NULL,
  calories        int,
  macros          jsonb,         -- {p,c,f}
  time_label      text,
  ingredients     jsonb,
  instructions    jsonb,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Training planning
CREATE TABLE training_programs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text,
  analysis       text,
  training_style text,
  is_recovery    boolean DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_training_programs_user ON training_programs(user_id);

CREATE TABLE training_days (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_program_id uuid NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
  day_index           int NOT NULL,
  focus               text,
  UNIQUE (training_program_id, day_index)
);

CREATE TABLE training_exercises (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_day_id  uuid NOT NULL REFERENCES training_days(id) ON DELETE CASCADE,
  name             text NOT NULL,
  sets             text,
  reps             text,
  notes            text,
  target_muscles   text[],
  equipment        text[],
  difficulty       text,
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Timeline (daily instantiation)
CREATE TABLE timeline_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         date NOT NULL,
  kind         text NOT NULL, -- meal, training_block, pledge, extra, block, quest, event
  ref_id       uuid,          -- meal.id veya training_exercises.id
  origin       text,          -- plan, extra, rescheduled, user_block
  title        text,
  start_time   text,
  end_time     text,
  status       text DEFAULT 'pending', -- pending, completed, skipped, mixed
  is_locked    boolean DEFAULT false,
  is_modified  boolean DEFAULT false,
  calories     int,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_timeline_user_date ON timeline_items(user_id, date);
CREATE INDEX idx_timeline_ref ON timeline_items(ref_id);

CREATE TABLE timeline_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_group_id   uuid NOT NULL,
  timeline_item_id uuid NOT NULL REFERENCES timeline_items(id) ON DELETE CASCADE
);
CREATE INDEX idx_timeline_links_group ON timeline_links(link_group_id);

-- Logs
CREATE TABLE food_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date               date NOT NULL,
  name               text NOT NULL,
  calories           int,
  protein            numeric(6,2),
  carbs              numeric(6,2),
  fat                numeric(6,2),
  status             text, -- matched, extra
  match_accuracy     numeric(5,2),
  linked_plan_item_id uuid REFERENCES timeline_items(id) ON DELETE SET NULL,
  image_url          text,
  metadata           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_logs_user_date ON food_logs(user_id, date);

CREATE TABLE exercise_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date               date NOT NULL,
  exercise_name      text NOT NULL,
  sets_json          jsonb,
  location           jsonb,
  estimated_calories int,
  verification       jsonb,
  feedback           jsonb,
  is_negotiated      boolean DEFAULT false,
  linked_plan_item_id uuid REFERENCES timeline_items(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_exercise_logs_user_date ON exercise_logs(user_id, date);

-- Bank / pledge
CREATE TABLE pledges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text,
  calories   int,
  date       date,
  status     text DEFAULT 'pending', -- pending, honored, failed
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pledges_user_date ON pledges(user_id, date);

CREATE TABLE bank_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  type       text NOT NULL, -- repayment, feast, donation, bankruptcy, austerity
  amount     int NOT NULL,
  description text,
  impact     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_bank_tx_user_date ON bank_transactions(user_id, date);

CREATE TABLE caloric_balances (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance    int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE surplus_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date               date NOT NULL,
  surplus            int,
  next_meal_name     text,
  next_meal_calories int,
  strategies         jsonb,
  resolved_strategy  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_surplus_user_date ON surplus_sessions(user_id, date);

-- Notifications
CREATE TABLE system_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  title      text,
  content    text,
  type       text, -- system, coach_update, community_alert
  priority   text, -- high, low
  read       boolean DEFAULT false,
  timestamp  timestamptz NOT NULL DEFAULT now(),
  payload    jsonb
);
CREATE INDEX idx_system_messages_user ON system_messages(user_id, read);

-- AI logging
CREATE TABLE ai_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  session_type text NOT NULL, -- meal_plan, training_plan, reroll_meal, reroll_exercise, deletion_analysis, chat
  model        text,
  status       text DEFAULT 'completed',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_sessions_user ON ai_sessions(user_id, session_type);

CREATE TABLE ai_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_session_id uuid NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role          text NOT NULL, -- system, user, assistant
  content       text,
  tokens        int,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_session_id uuid NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  ref_table     text,   -- meal_plans, training_programs, timeline_items vb.
  ref_id        uuid,
  artifact_type text,  -- meal_plan_json, training_program_json, recipe, exercise, image, video
  content       jsonb,  -- veya url/base64
  content_hash  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_artifacts_ref ON ai_artifacts(ref_table, ref_id);

-- Gamification (optional)
CREATE TABLE flash_quests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text,
  description  text,
  expires_at   timestamptz,
  reward       jsonb,
  type         text, -- cardio, strength, mind
  safety_tags  text[],
  is_active    boolean DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_flash_quests_user ON flash_quests(user_id);

-- Feature flags
CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  description text,
  rollout     jsonb, -- % veya segment kurallarÄ±
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_features (
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  feature_key text REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled    boolean NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

-- GAMIFICATION & OPTIMIZATION (Added 2026-01-06)

-- Users Table Updates (Manual additions to match migration)
-- Note: In a real testdb, we might alter or just add these to the CREATE definition.
-- For now, appending ALTERs for clarity in this append-only log.

ALTER TABLE users ADD COLUMN IF NOT EXISTS calorie_bank INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS metabolic_status VARCHAR(50) DEFAULT 'adaptive';

-- Guilds
CREATE TABLE guilds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    leader_id UUID REFERENCES users(id),
    team_streak INTEGER DEFAULT 0,
    total_xp BIGINT DEFAULT 0,
    visibility VARCHAR(20) DEFAULT 'public',
    invite_code VARCHAR(50) UNIQUE
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS guild_id UUID REFERENCES guilds(id);

-- Metabolic Alerts
CREATE TABLE metabolic_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    type VARCHAR(50) NOT NULL,
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    details TEXT,
    recommendation VARCHAR(50),
    status VARCHAR(20) DEFAULT 'active'
);

-- Health Reports
CREATE TABLE health_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    period VARCHAR(20),
    content TEXT,
    format VARCHAR(10)
);

-- Wearable Metrics
CREATE TABLE wearable_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    source VARCHAR(50),
    steps INTEGER,
    active_calories INTEGER,
    sleep_minutes INTEGER,
    sleep_score INTEGER,
    hrv INTEGER,
    resting_hr INTEGER,
    raw_data JSONB
);

-- Initial Game Items (Streak Freeze)
INSERT INTO game_items (id, name, description, type, rarity, cost_currency, cost_amount, is_consumable)
VALUES (
    'item_streak_freeze',
    'Streak Freeze',
    'Protects your streak for 24 hours. Auto-consumes on missed check-in.',
    'utility',
    'rare',
    'sparks',
    250,
    TRUE
) ON CONFLICT (id) DO NOTHING;

-- 1. Ledger Entries (The Bank & Vault Transaction History)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'missed_meal', 'missed_workout', 'vault_deposit', 'redeem_vacation', 'extra_food'
    name VARCHAR(255) NOT NULL,
    calories INTEGER NOT NULL, -- Positive = Credit (Saved), Negative = Debt (Owed)
    date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'remedied', 'forgiven', 'honored'
    remedy_log_id VARCHAR(255) -- Link to the workout/log that fixed a debt
);

-- 2. User Updates (Vault Balance)
ALTER TABLE users ADD COLUMN IF NOT EXISTS vault_balance INTEGER DEFAULT 0;

-- 3. Behavioral Pledges
CREATE TABLE IF NOT EXISTS user_pledges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'iron_contract', 'public_vow', 'momentum'
    goal_type VARCHAR(50) NOT NULL, -- 'log_streak', 'workout_frequency', 'no_sugar', 'sleep_early'
    stake_amount INTEGER DEFAULT 0, -- Sparks staked
    target_value INTEGER, -- e.g. 3 days, 5 workouts
    current_value INTEGER DEFAULT 0,
    start_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    end_date TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'success', 'failed'
    contract_address VARCHAR(255) -- Optional: for "Smart Contract" flair or hash
);

-- 4. Initial "Vacation Mode" Item in Shop
INSERT INTO game_items (id, name, description, type, rarity, cost, is_consumable)
VALUES (
    'item_vacation_ticket',
    'Vacation Ticket (1 Day)',
    'Freeze your streak for 24 hours. Purchased with Vault Balance.',
    'utility',
    'legendary',
    '{"currency": "vault_calories", "amount": 2000}',
    true
) ON CONFLICT (id) DO NOTHING;
