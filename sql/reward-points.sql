-- Reward points: customer balance, ledger, order accrual.
-- Run once on Postgres (or rely on startup ALTER in index.ts for columns).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS reward_points_balance INT NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_earned INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reward_discount_azn NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS reward_points_ledger (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id VARCHAR(64) NOT NULL,
  points_delta INT NOT NULL,
  balance_after INT NOT NULL,
  reward_azn NUMERIC(12,4),
  tier_percent NUMERIC(5,2),
  eligible_subtotal_azn NUMERIC(12,2),
  reason VARCHAR(80) NOT NULL DEFAULT 'purchase',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_reward_points_ledger_customer_id ON reward_points_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_reward_points_ledger_expires_at ON reward_points_ledger(expires_at);
