-- Add order_id to payment_intents for idempotent order creation.
-- Prevents duplicate orders when the success page is refreshed or revisited.
-- Run once on your Postgres.

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS order_id VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order_id ON payment_intents(order_id) WHERE order_id IS NOT NULL;
