-- Migration: Add Gamification, Social, and Metabolic Features
-- Created: 2026-01-06
-- 1. Users Table Updates
ALTER TABLE users
ADD COLUMN calorie_bank INTEGER DEFAULT 0;

ALTER TABLE users
ADD COLUMN metabolic_status VARCHAR(50) DEFAULT 'adaptive';

-- 'adaptive', 'responsive', 'plateau'
-- Note: Guild ID will be handled via the relationships, or typically users.guild_id
-- 2. Guilds Table
CREATE TABLE guilds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4 (),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        leader_id UUID REFERENCES users (id),
        team_streak INTEGER DEFAULT 0,
        total_xp BIGINT DEFAULT 0,
        visibility VARCHAR(20) DEFAULT 'public', -- 'public', 'private'
        invite_code VARCHAR(50) UNIQUE
);

-- Add guild_id to users after creating guilds table
ALTER TABLE users
ADD COLUMN guild_id UUID REFERENCES guilds (id);

-- 3. Guild Members (Junction - optional if 1:1, but good for history/expansion)
-- If we stick to 1 guild per user strictly, the users.guild_id FK is sufficient.
-- If we want to track 'roles' within a guild or multiple guilds, we need this table.
-- For simpler 'Groups of 5', strict 1-guild logic on users table is often easier.
-- 4. Metabolic Alerts
CREATE TABLE metabolic_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4 (),
    user_id UUID REFERENCES users (id) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'plateau', 'rapid_loss', 'rapid_gain'
    detected_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        details TEXT,
        recommendation VARCHAR(50), -- 'diet_break', 'recalculate'
        status VARCHAR(20) DEFAULT 'active' -- 'active', 'dismissed', 'resolved'
);

-- 5. Health Reports (Snapshots)
CREATE TABLE health_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4 (),
    user_id UUID REFERENCES users (id) NOT NULL,
    generated_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        period VARCHAR(20), -- 'month', 'quarter'
        content TEXT, -- JSON blob or Markdown
        format VARCHAR(10) -- 'json', 'pdf'
);

-- 6. Wearable Metrics (Time Series)
CREATE TABLE wearable_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4 (),
    user_id UUID REFERENCES users (id) NOT NULL,
    timestamp TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        source VARCHAR(50), -- 'apple', 'google', 'oura'
        steps INTEGER,
        active_calories INTEGER,
        sleep_minutes INTEGER,
        sleep_score INTEGER,
        hrv INTEGER,
        resting_hr INTEGER,
        raw_data JSONB -- Store full payload for future AI analysis
);

-- 7. Seed Inventory Items (Streak Freeze)
INSERT INTO
    game_items (
        id,
        name,
        description,
        type,
        rarity,
        cost_currency,
        cost_amount,
        is_consumable
    )
VALUES
    (
        'item_streak_freeze',
        'Streak Freeze',
        'Protects your streak for 24 hours. Auto-consumes on missed check-in.',
        'utility',
        'rare',
        'sparks',
        250, -- Base cost in Coins
        TRUE
    ) ON CONFLICT (id) DO NOTHING;