import { Request, Response } from 'express';
import {
  getCartItems,
  upsertCartItem,
  deleteCartItem,
  replaceCart,
  mergeCart,
  clearCart,
} from '../services/cartService';

function pickString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** GET /api/v1/auth/cart */
export async function getCart(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const items = await getCartItems(uid);
    res.json({ items });
  } catch (err) {
    console.error('getCart:', err);
    res.status(500).json({ error: 'Could not load cart.' });
  }
}

/** PUT /api/v1/auth/cart/items — upsert one line */
export async function putCartItem(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const product_id = pickString(body, ['product_id', 'productId']) ?? '';
    const sku_color = pickString(body, ['sku_color', 'skuColor']) ?? '';
    const size = pickString(body, ['size']) ?? '';
    const qtyRaw = body.quantity;
    const quantity = typeof qtyRaw === 'number' ? qtyRaw : Number(qtyRaw);
    const row = await upsertCartItem(uid, { product_id, sku_color, size, quantity });
    res.json({ item: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid request';
    if (msg.includes('required') || msg.includes('quantity')) {
      res.status(400).json({ error: msg });
      return;
    }
    console.error('putCartItem:', err);
    res.status(500).json({ error: 'Could not update cart item.' });
  }
}

/** DELETE /api/v1/auth/cart/items — body: sku_color, size */
export async function removeCartItem(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const sku_color = pickString(body, ['sku_color', 'skuColor']) ?? '';
    const size = pickString(body, ['size']) ?? '';
    if (!sku_color || !size) {
      res.status(400).json({ error: 'sku_color and size are required.' });
      return;
    }
    const ok = await deleteCartItem(uid, sku_color, size);
    res.json({ ok, deleted: ok });
  } catch (err) {
    console.error('removeCartItem:', err);
    res.status(500).json({ error: 'Could not remove cart item.' });
  }
}

/** POST /api/v1/auth/cart/sync — body: { items: [...], mode?: 'merge' | 'replace' } */
export async function syncCart(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const rawItems = body.items;
    const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'merge';
    if (!Array.isArray(rawItems)) {
      res.status(400).json({ error: 'items must be an array.' });
      return;
    }

    const parsed: Array<{ product_id: string; sku_color: string; size: string; quantity: number }> = [];
    for (const el of rawItems) {
      if (!el || typeof el !== 'object') continue;
      const o = el as Record<string, unknown>;
      const product_id = pickString(o, ['product_id', 'productId']) ?? '';
      const sku_color = pickString(o, ['sku_color', 'skuColor']) ?? '';
      const size = pickString(o, ['size']) ?? '';
      const q = o.quantity;
      const quantity = typeof q === 'number' ? q : Number(q);
      if (!product_id || !sku_color || !size) continue;
      if (!Number.isFinite(quantity) || quantity < 1) continue;
      parsed.push({
        product_id,
        sku_color,
        size,
        quantity: Math.floor(quantity),
      });
    }

    // Dedupe by sku_color+size (last wins for product_id, max quantity)
    const byKey = new Map<
      string,
      { product_id: string; sku_color: string; size: string; quantity: number }
    >();
    for (const it of parsed) {
      const k = `${it.sku_color}|||${it.size}`;
      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, { ...it });
      } else {
        byKey.set(k, {
          ...it,
          product_id: it.product_id || prev.product_id,
          quantity: Math.max(prev.quantity, it.quantity),
        });
      }
    }
    const deduped = Array.from(byKey.values());

    let items;
    if (mode === 'replace') {
      items = await replaceCart(uid, deduped);
    } else {
      items = await mergeCart(uid, deduped, { dropMissing: false });
    }
    res.json({ items });
  } catch (err) {
    console.error('syncCart:', err);
    res.status(500).json({ error: 'Could not sync cart.' });
  }
}

/** DELETE /api/v1/auth/cart — clear entire cart */
export async function deleteCartAll(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    await clearCart(uid);
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteCartAll:', err);
    res.status(500).json({ error: 'Could not clear cart.' });
  }
}
