-- Moderation Queue Migration
-- Required for App Store Compliance (UGC)
CREATE TABLE IF NOT EXISTS moderation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    target_id UUID NOT NULL, -- Flexible ID (Post ID, User ID, etc)
    target_type VARCHAR(50) NOT NULL, -- 'post', 'user', 'message'
    reason VARCHAR(255),
    reporter_comment TEXT,
    reporter_id UUID REFERENCES users (id) ON DELETE SET NULL,
    content JSONB DEFAULT '{}', -- Snapshot of the bad content
    status VARCHAR(50) DEFAULT 'pending', -- pending, resolved, dismissed
    resolution_action VARCHAR(255), -- 'ban_user', 'delete_post', 'ignore'
    ai_analysis TEXT, -- Future proofing for AI auto-mod
    timestamp TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW ()
);

CREATE INDEX idx_mod_status ON moderation_queue (status);

CREATE INDEX idx_mod_target ON moderation_queue (target_id);