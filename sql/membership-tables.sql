-- Run this on your Render Postgres if membership_levels / customer_memberships don't exist yet.
-- (customers table is assumed to already exist.)

CREATE TABLE IF NOT EXISTS membership_levels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  min_spent NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_memberships (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  membership_level_id INT NOT NULL REFERENCES membership_levels(id),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  UNIQUE(customer_id, membership_level_id, start_date)
);

-- Optional: create index for lookups
CREATE INDEX IF NOT EXISTS idx_customer_memberships_customer_id ON customer_memberships(customer_id);
CREATE INDEX IF NOT EXISTS idx_membership_levels_name ON membership_levels(LOWER(name));
