import { pool } from '../db';
import type { OrderItem } from './orderService';
import {
  calculatePointsForOrder,
  POINTS_EXPIRY_MONTHS,
  type LineForPoints,
} from './rewardPointsPolicy';

function itemsToLines(items: OrderItem[]): LineForPoints[] {
  return (items || []).map((it) => ({
    quantity: it.quantity,
    price: Number(it.price) || 0,
    is_discounted:
      it.is_discounted === true ||
      (typeof it.is_discounted === 'string' && it.is_discounted === 'true'),
    promotional:
      it.promotional === true ||
      (typeof it.promotional === 'string' && it.promotional === 'true') ||
      (typeof it.product_id === 'string' && it.product_id === '__delivery__'),
  }));
}

/**
 * Award reward points after a paid order (idempotent per order_id + reason purchase).
 * Skips guests, zero points, or if ledger row already exists.
 */
export async function tryAwardRewardPointsForOrder(order: {
  id: string;
  customer_id: number | null | undefined;
  items: OrderItem[];
}): Promise<void> {
  const customerId = order.customer_id != null ? Number(order.customer_id) : NaN;
  if (!Number.isFinite(customerId) || customerId <= 0) return;

  const orderIdStr = String(order.id);
  const lines = itemsToLines(order.items || []);
  const { eligibleSubtotalAzn, tierPercent, rewardAzn, points } = calculatePointsForOrder(lines);
  if (points <= 0) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT 1 FROM reward_points_ledger WHERE order_id = $1 AND reason = 'purchase' LIMIT 1`,
      [orderIdStr]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return;
    }

    const balRes = await client.query(
      `SELECT COALESCE(reward_points_balance, 0)::int AS b FROM customers WHERE id = $1 FOR UPDATE`,
      [customerId]
    );
    if (!balRes.rows[0]) {
      await client.query('ROLLBACK');
      return;
    }
    const prev = Number(balRes.rows[0].b) || 0;
    const next = prev + points;

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

    await client.query(
      `UPDATE customers SET reward_points_balance = $1 WHERE id = $2`,
      [next, customerId]
    );
    await client.query(
      `INSERT INTO reward_points_ledger (
        customer_id, order_id, points_delta, balance_after, reward_azn, tier_percent, eligible_subtotal_azn, reason, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'purchase', $8)`,
      [
        customerId,
        orderIdStr,
        points,
        next,
        rewardAzn,
        tierPercent,
        eligibleSubtotalAzn,
        expiresAt.toISOString(),
      ]
    );
    await client.query(`UPDATE orders SET points_earned = $1 WHERE id = $2`, [points, orderIdStr]);
    await client.query('COMMIT');
    console.log('[RewardPoints] Awarded', points, 'points for order', orderIdStr, 'customer', customerId);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation "reward_points_ledger" does not exist|column .* does not exist/i.test(msg)) {
      console.warn('[RewardPoints] Tables/columns missing — run sql/reward-points.sql:', msg);
      return;
    }
    console.error('[RewardPoints] Award failed:', msg);
  } finally {
    client.release();
  }
}
