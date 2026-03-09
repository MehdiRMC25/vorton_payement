-- Allow guest orders (payment checkout without customer account).
-- Run once so customer_id can be NULL for guest orders. FK remains for non-null values.
ALTER TABLE orders
  ALTER COLUMN customer_id DROP NOT NULL;
