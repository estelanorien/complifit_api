-- Migration: Add topic subscriptions for FCM push notifications
-- This table tracks which FCM topics each user is subscribed to

CREATE TABLE IF NOT EXISTS user_topic_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, topic)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_user_topic_subscriptions_user_id ON user_topic_subscriptions(user_id);

-- Index for finding all subscribers to a topic
CREATE INDEX IF NOT EXISTS idx_user_topic_subscriptions_topic ON user_topic_subscriptions(topic);
