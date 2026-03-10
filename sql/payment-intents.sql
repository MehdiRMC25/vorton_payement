-- Payment intents: persist so order creation survives server restarts (e.g. Render cold start).
-- Run once on your Postgres.

CREATE TABLE IF NOT EXISTS payment_intents (
  id SERIAL PRIMARY KEY,
  payment_id VARCHAR(100) NOT NULL UNIQUE,
  bank_order_id VARCHAR(100) NOT NULL UNIQUE,
  bank_order_secret TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  amount NUMERIC(12,2),
  currency VARCHAR(3),
  order_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_bank_order_id ON payment_intents(bank_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_created_at ON payment_intents(created_at);
