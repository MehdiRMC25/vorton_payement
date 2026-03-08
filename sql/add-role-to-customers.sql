-- Fix signup 500 error: getCustomerByIdSafe expects a "role" column.
-- Run this once on your Postgres (e.g. Render) if you get "missing column" on signup.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'customer';
