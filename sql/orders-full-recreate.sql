-- ============================================================
-- Full recreate: orders + order_status_history
-- Run in PostgreSQL. All data in these tables will be lost.
-- ============================================================

DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR(50) NOT NULL,
  customer_id INT,
  customer_name VARCHAR(200) NOT NULL DEFAULT '',
  mobile VARCHAR(30) NOT NULL DEFAULT '',
  membership_level VARCHAR(20) NOT NULL DEFAULT 'none',
  address TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  total_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  order_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'PROCESSING', 'DISPATCHED', 'DELIVERED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_orders_order_number ON orders(order_number);
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_order_date ON orders(order_date);

CREATE TABLE order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_status_history_order_id ON order_status_history(order_id);
