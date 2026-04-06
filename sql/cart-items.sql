-- Server-side cart for signed-in users (sync with web + mobile).
-- Run once on PostgreSQL if not already applied.

CREATE TABLE IF NOT EXISTS cart_items (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  sku_color TEXT NOT NULL,
  size TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, sku_color, size)
);

CREATE INDEX IF NOT EXISTS cart_items_user_id_idx ON cart_items(user_id);
