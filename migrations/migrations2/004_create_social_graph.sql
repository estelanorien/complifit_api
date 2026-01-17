DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'connection_status') THEN
        CREATE TYPE connection_status AS ENUM ('pending', 'accepted', 'blocked');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    follower_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status connection_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW (),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW (),
    -- Prevent self-following
    CONSTRAINT no_self_follow CHECK (follower_id != following_id),
    -- Ensure unique relationship pair
    CONSTRAINT unique_friendship UNIQUE (follower_id, following_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_friendships_follower ON friendships (follower_id);
CREATE INDEX IF NOT EXISTS idx_friendships_following ON friendships (following_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships (status);