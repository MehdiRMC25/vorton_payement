-- Optional: tables are also created on server startup when DATABASE_URL/PG is set.
-- Run manually if you need them without restarting the app.

CREATE TABLE IF NOT EXISTS email_change_pending (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  new_email VARCHAR(255) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(customer_id)
);

CREATE TABLE IF NOT EXISTS customer_delivery_contact_log (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone VARCHAR(64),
  address_text TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'checkout',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_contact_customer ON customer_delivery_contact_log(customer_id);
