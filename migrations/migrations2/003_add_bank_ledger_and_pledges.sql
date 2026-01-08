-- 1. Ledger Entries (The Bank & Vault Transaction History)
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID REFERENCES users (id) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'missed_meal', 'missed_workout', 'vault_deposit', 'redeem_vacation', 'extra_food'
    name VARCHAR(255) NOT NULL,
    calories INTEGER NOT NULL, -- Positive = Credit (Saved), Negative = Debt (Owed)
    date TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'remedied', 'forgiven', 'honored'
        remedy_log_id VARCHAR(255) -- Link to the workout/log that fixed a debt
);

-- 2. User Updates (Vault Balance)
ALTER TABLE users
ADD COLUMN vault_balance INTEGER DEFAULT 0;

-- 3. Behavioral Pledges
CREATE TABLE user_pledges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID REFERENCES users (id) NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'iron_contract', 'public_vow', 'momentum'
    goal_type VARCHAR(50) NOT NULL, -- 'log_streak', 'workout_frequency', 'no_sugar', 'sleep_early'
    stake_amount INTEGER DEFAULT 0, -- Sparks staked
    target_value INTEGER, -- e.g. 3 days, 5 workouts
    current_value INTEGER DEFAULT 0,
    start_date TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW (),
        end_date TIMESTAMP
    WITH
        TIME ZONE,
        status VARCHAR(20) DEFAULT 'active', -- 'active', 'success', 'failed'
        contract_address VARCHAR(255) -- Optional: for "Smart Contract" flair or hash
);

-- 4. Initial "Vacation Mode" Item in Shop
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
        'item_vacation_ticket',
        'Vacation Ticket (1 Day)',
        'Freeze your streak for 24 hours. Purchased with Vault Balance.',
        'utility',
        'legendary',
        'vault_calories', -- Special currency: Vault Calories
        2000, -- Cost: 2000 saved calories = 1 day off
        true
    );