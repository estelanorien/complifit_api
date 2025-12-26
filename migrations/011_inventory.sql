-- Treat Shop inventory & transaction history
CREATE TABLE IF NOT EXISTS user_inventory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id text NOT NULL REFERENCES game_items(id) ON DELETE CASCADE,
    quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    last_acquired_at timestamptz,
    last_consumed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_inventory_unique
    ON user_inventory (user_id, item_id);

CREATE TABLE IF NOT EXISTS inventory_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id text REFERENCES game_items(id) ON DELETE SET NULL,
    transaction_type text NOT NULL,
    quantity integer NOT NULL,
    cost jsonb,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_tx_user_time
    ON inventory_transactions (user_id, created_at DESC);


