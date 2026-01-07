-- Calorie bank transactions & event sessions
CREATE TABLE IF NOT EXISTS calorie_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL, -- repayment, feast, donation, bankruptcy, pledge, negotiation, etc.
    amount integer NOT NULL,
    description text,
    impact jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calorie_transactions_user ON calorie_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_active boolean NOT NULL DEFAULT true,
    start_time timestamptz NOT NULL DEFAULT now(),
    end_time timestamptz,
    accumulated_calories integer NOT NULL DEFAULT 0,
    review_unlock_time timestamptz,
    pending_review boolean NOT NULL DEFAULT false,
    metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_event_sessions_user_active ON event_sessions(user_id, is_active);


