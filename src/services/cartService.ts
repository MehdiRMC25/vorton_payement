import { pool } from '../db';

export type CartItemRow = {
  id: string;
  user_id: number;
  product_id: string;
  sku_color: string;
  size: string;
  quantity: number;
  updated_at: string;
};

function trim(s: unknown): string {
  return typeof s === 'string' ? s.trim() : '';
}

export async function getCartItems(userId: number): Promise<CartItemRow[]> {
  const result = await pool.query(
    `SELECT id, user_id, product_id, sku_color, size, quantity, updated_at
     FROM cart_items
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );
  return (result.rows || []).map((r) => ({
    id: String(r.id),
    user_id: Number(r.user_id),
    product_id: String(r.product_id),
    sku_color: String(r.sku_color),
    size: String(r.size),
    quantity: Number(r.quantity),
    updated_at:
      r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));
}

export async function upsertCartItem(
  userId: number,
  input: { product_id: string; sku_color: string; size: string; quantity: number }
): Promise<CartItemRow> {
  const product_id = trim(input.product_id);
  const sku_color = trim(input.sku_color);
  const size = trim(input.size);
  const quantity = Math.floor(Number(input.quantity));
  if (!product_id || !sku_color || !size) {
    throw new Error('product_id, sku_color, and size are required');
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }

  const result = await pool.query(
    `INSERT INTO cart_items (user_id, product_id, sku_color, size, quantity, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id, sku_color, size)
     DO UPDATE SET
       product_id = EXCLUDED.product_id,
       quantity = EXCLUDED.quantity,
       updated_at = now()
     RETURNING id, user_id, product_id, sku_color, size, quantity, updated_at`,
    [userId, product_id, sku_color, size, quantity]
  );
  const r = result.rows[0];
  return {
    id: String(r.id),
    user_id: Number(r.user_id),
    product_id: String(r.product_id),
    sku_color: String(r.sku_color),
    size: String(r.size),
    quantity: Number(r.quantity),
    updated_at:
      r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function deleteCartItem(
  userId: number,
  sku_color: string,
  size: string
): Promise<boolean> {
  const sc = trim(sku_color);
  const sz = trim(size);
  if (!sc || !sz) return false;
  const result = await pool.query(
    `DELETE FROM cart_items WHERE user_id = $1 AND sku_color = $2 AND size = $3`,
    [userId, sc, sz]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Replace entire cart with the given items (atomic). */
export async function replaceCart(
  userId: number,
  items: Array<{ product_id: string; sku_color: string; size: string; quantity: number }>
): Promise<CartItemRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM cart_items WHERE user_id = $1`, [userId]);
    for (const it of items) {
      const product_id = trim(it.product_id);
      const sku_color = trim(it.sku_color);
      const size = trim(it.size);
      const quantity = Math.floor(Number(it.quantity));
      if (!product_id || !sku_color || !size || !Number.isFinite(quantity) || quantity < 1) {
        continue;
      }
      await client.query(
        `INSERT INTO cart_items (user_id, product_id, sku_color, size, quantity, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, sku_color, size)
         DO UPDATE SET product_id = EXCLUDED.product_id, quantity = EXCLUDED.quantity, updated_at = now()`,
        [userId, product_id, sku_color, size, quantity]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
  return getCartItems(userId);
}

/**
 * Merge server cart with client items: for each key (sku_color, size), keep max(quantity).
 * Rows only on server that are not in client are kept unless dropMissing is true.
 */
export async function mergeCart(
  userId: number,
  items: Array<{ product_id: string; sku_color: string; size: string; quantity: number }>,
  options?: { dropMissing?: boolean }
): Promise<CartItemRow[]> {
  const dropMissing = options?.dropMissing === true;
  const existing = await getCartItems(userId);
  const key = (sc: string, sz: string) => `${sc}|||${sz}`;
  const incoming = new Map<
    string,
    { product_id: string; sku_color: string; size: string; quantity: number }
  >();

  for (const it of items) {
    const product_id = trim(it.product_id);
    const sku_color = trim(it.sku_color);
    const size = trim(it.size);
    const quantity = Math.floor(Number(it.quantity));
    if (!product_id || !sku_color || !size || !Number.isFinite(quantity) || quantity < 1) {
      continue;
    }
    const k = key(sku_color, size);
    const prev = incoming.get(k);
    if (!prev) {
      incoming.set(k, { product_id, sku_color, size, quantity });
    } else {
      incoming.set(k, {
        product_id: product_id || prev.product_id,
        sku_color,
        size,
        quantity: Math.max(prev.quantity, quantity),
      });
    }
  }

  for (const row of existing) {
    const k = key(row.sku_color, row.size);
    const inc = incoming.get(k);
    if (inc) {
      inc.quantity = Math.max(inc.quantity, row.quantity);
      inc.product_id = inc.product_id || row.product_id;
    } else if (!dropMissing) {
      incoming.set(k, {
        product_id: row.product_id,
        sku_color: row.sku_color,
        size: row.size,
        quantity: row.quantity,
      });
    }
  }

  const merged = Array.from(incoming.values());
  return replaceCart(userId, merged);
}

export async function clearCart(userId: number): Promise<void> {
  await pool.query(`DELETE FROM cart_items WHERE user_id = $1`, [userId]);
}
