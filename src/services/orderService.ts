import type { PoolClient } from 'pg';
import { pool } from '../db';
import { getCustomerMembership } from './membershipService';
import {
  CHECKOUT_AMOUNT_EPS,
  computeCheckoutBreakdown,
  resolveMembershipForCustomer,
  applyPromoToBreakdown,
  recordPromoRedemption,
} from './checkoutTotalsService';

const ALLOWED_STATUSES = ['PROCESSING', 'DISPATCHED', 'DELIVERED'] as const;
export type OrderStatus = 'NEW' | typeof ALLOWED_STATUSES[number];

/** Item shape for Delivery/Order Tracking; frontend expects name, quantity, price, and optionally sku_color, size, product_id. */
export interface OrderItem {
  product_id?: string;
  name: string;
  quantity: number;
  price: number;
  sku_color?: string;
  size?: string;
  /** When true, line is excluded from reward-points eligible subtotal. */
  is_discounted?: boolean;
  promotional?: boolean;
  [key: string]: unknown;
}

export interface CreateOrderInput {
  customer_id?: number | null;
  customer_name: string;
  mobile: string;
  membership_level: string;
  address?: string | null;
  items: OrderItem[];
  /** Net amount paid (merchandise minus points discount when redeeming). */
  total_price: number;
  delivery_due_date?: string | null;
  /** Whole points to redeem; omit or 0 to pay full merchandise total. */
  points_to_redeem?: number;
  /** Optional promo code; invalid code must not block checkout. */
  promo_code?: string | null;
  /** With checkout_currency, shipping fee follows zone table; else from __delivery__ lines. */
  delivery_city?: string | null;
  delivery_country?: string | null;
  checkout_currency?: string | null;
}

function generateOrderNumber(): string {
  const digits = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  const letters = Array.from({ length: 4 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]
  ).join('');
  return `VRT-${digits}-${letters}`;
}

async function insertOrderRow(
  client: PoolClient,
  params: {
    order_number: string;
    customer_id: number | null;
    customer_name: string;
    mobile: string;
    membership_level: string;
    address: string | null;
    itemsJson: string;
    netTotal: number;
    delivery_due_date: string | null;
    pointsRedeemed: number;
    discountAzn: number;
    promoCode: string | null;
    promoDiscountAzn: number;
    promoLabel: string | null;
    membershipDiscountAzn: number;
  }
): Promise<{ id: string; order_number: string }> {
  const result = await client.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, mobile, membership_level,
      address, items, total_price, delivery_due_date, status,
      points_redeemed, reward_discount_azn, membership_discount_azn,
      promo_code, promo_discount_azn, promo_label
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::date, 'PROCESSING', $10, $11, $12, $13, $14, $15)
    RETURNING id, order_number`,
    [
      params.order_number,
      params.customer_id,
      params.customer_name,
      params.mobile,
      params.membership_level,
      params.address,
      params.itemsJson,
      params.netTotal,
      params.delivery_due_date,
      params.pointsRedeemed,
      params.discountAzn,
      params.membershipDiscountAzn,
      params.promoCode,
      params.promoDiscountAzn,
      params.promoLabel,
    ]
  );
  const row = result.rows[0];
  await client.query(`INSERT INTO order_status_history (order_id, status) VALUES ($1, 'PROCESSING')`, [row.id]);
  return { id: String(row.id), order_number: String(row.order_number) };
}

export async function createOrder(input: CreateOrderInput): Promise<{ id: string; order_number: string }> {
  let membership_level = input.membership_level || 'none';
  if (input.customer_id != null) {
    try {
      const membership = await getCustomerMembership(input.customer_id);
      if (membership?.name) {
        membership_level = membership.name.toLowerCase();
      }
    } catch (err) {
      console.warn('[Order] Could not fetch membership for customer', input.customer_id, err);
    }
  }

  const order_number = generateOrderNumber();
  const ptsReq = Math.max(0, Math.floor(Number(input.points_to_redeem) || 0));
  const { fraction: membershipFraction, levelName: membershipResolvedName } =
    await resolveMembershipForCustomer(
      input.customer_id != null && Number.isFinite(Number(input.customer_id)) ? Number(input.customer_id) : null
    );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let pointsRedeemed = 0;
    let discountAzn = 0;
    let newBalance = 0;
    let membershipDiscountAzn = 0;
    let promoCodeApplied: string | null = null;
    let promoDiscountAzn = 0;
    let promoLabel: string | null = null;
    const cid =
      input.customer_id != null && Number.isFinite(Number(input.customer_id))
        ? Number(input.customer_id)
        : NaN;

    let balancePoints = 0;
    if (ptsReq > 0) {
      if (!Number.isFinite(cid) || cid <= 0) {
        throw new Error('customer_id is required when redeeming reward points');
      }
      const balRes = await client.query(
        `SELECT COALESCE(reward_points_balance, 0)::int AS b FROM customers WHERE id = $1 FOR UPDATE`,
        [cid]
      );
      if (!balRes.rows[0]) {
        throw new Error('Customer not found for points redemption');
      }
      balancePoints = Number(balRes.rows[0].b) || 0;
    }
    let customerEmail: string | null = null;
    let customerMobile: string | null = null;
    let customerCity: string | null = null;
    let customerCountry: string | null = null;

    if (Number.isFinite(cid) && cid > 0) {
      const c = await client.query(
          `SELECT
         NULLIF(TRIM(email), '') AS email,
         NULLIF(TRIM(phone), '') AS phone,
         NULLIF(TRIM(city), '') AS city,
         NULLIF(TRIM(country), '') AS country
       FROM customers
       WHERE id = $1
       LIMIT 1`,
          [cid]
      );
      customerEmail = (c.rows[0]?.email as string | null) ?? null;
      customerMobile = (c.rows[0]?.phone as string | null) ?? null;
      customerCity = (c.rows[0]?.city as string | null) ?? null;
      customerCountry = (c.rows[0]?.country as string | null) ?? null;
    }


    const baseBreakdown = computeCheckoutBreakdown({
      items: input.items || [],
      pointsRequested: ptsReq,
      balancePoints,
      membershipCatalogFraction: membershipFraction,
      membershipLevelName: membershipResolvedName,
      shipping: {
        delivery_city: input.delivery_city,
        delivery_country: input.delivery_country,
        checkout_currency: input.checkout_currency,
      },
    });

    const breakdown = await applyPromoToBreakdown(baseBreakdown, {
      promoCode: input.promo_code ?? null,
      customerId: Number.isFinite(cid) ? cid : null,
      membershipLevelName: membershipResolvedName,
      email: customerEmail,
      mobile: customerMobile,
      city: input.delivery_city ?? customerCity,
      country: input.delivery_country ?? customerCountry,
      lockUsage: true,
      client,
    });

    pointsRedeemed = breakdown.pointsRedeemed;
    discountAzn = breakdown.pointsDiscountAzn;
    membershipDiscountAzn = breakdown.membershipDiscountAzn;
    promoCodeApplied = breakdown.promo_code ?? null;
    promoDiscountAzn = Number(breakdown.promo_discount_azn ?? 0);
    promoLabel = breakdown.promo_label ?? null;
    const net = breakdown.payableTotalAzn;

    if (ptsReq > 0 && Number.isFinite(cid) && cid > 0) {
      newBalance = balancePoints - pointsRedeemed;
    }

    if (Math.abs(net - Number(input.total_price)) > CHECKOUT_AMOUNT_EPS) {
      throw new Error(
        'total_price must match authoritative checkout total (merchandise − membership − points + shipping)'
      );
    }

    const row = await insertOrderRow(client, {
      order_number,
      customer_id: Number.isFinite(cid) ? cid : null,
      customer_name: input.customer_name,
      mobile: input.mobile,
      membership_level,
      address: input.address ?? null,
      itemsJson: JSON.stringify(input.items || []),
      netTotal: net,
      delivery_due_date: input.delivery_due_date ?? null,
      pointsRedeemed,
      discountAzn,
      promoCode: promoCodeApplied,
      promoDiscountAzn,
      promoLabel,
      membershipDiscountAzn,
    });

    if (pointsRedeemed > 0 && Number.isFinite(cid) && cid > 0) {
      await client.query(`UPDATE customers SET reward_points_balance = $1 WHERE id = $2`, [
        newBalance,
        cid,
      ]);
      await client.query(
        `INSERT INTO reward_points_ledger (
          customer_id, order_id, points_delta, balance_after, reward_azn, reason
        ) VALUES ($1, $2, $3, $4, $5, 'redeem')`,
        [cid, row.id, -pointsRedeemed, newBalance, discountAzn]
      );
    }

    if (promoCodeApplied && promoDiscountAzn > 0) {
      await recordPromoRedemption({
        client,
        promoCode: promoCodeApplied,
        customerId: Number.isFinite(cid) ? cid : null,
        orderId: row.id,
        promoDiscountAzn,
      });
    }

    await client.query('COMMIT');
    return row;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getAllOrders(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.customer_id, o.customer_name, o.mobile, o.membership_level,
            o.address, o.items, o.total_price, o.order_date, o.delivery_due_date, o.status, o.created_at, o.updated_at,
            COALESCE(o.points_redeemed, 0)::int AS points_redeemed,
            COALESCE(o.reward_discount_azn, 0)::numeric AS reward_discount_azn,
            COALESCE(o.membership_discount_azn, 0)::numeric AS membership_discount_azn,
            COALESCE(o.points_earned, 0)::int AS points_earned,
       o.promo_code,
            COALESCE(o.promo_discount_azn, 0)::numeric AS promo_discount_azn,
       o.promo_label,
            (SELECT osh.created_at FROM order_status_history osh
             WHERE osh.order_id = o.id AND osh.status = 'DELIVERED'
             ORDER BY osh.created_at DESC LIMIT 1) AS delivered_at
     FROM orders o ORDER BY o.order_date DESC`
  );
  return result.rows.map(row => formatOrderRow(row));
}

export async function getOrderById(id: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await pool.query(
      `SELECT id, order_number, customer_id, customer_name, mobile, membership_level,
              address, items, total_price, order_date, delivery_due_date, status, created_at, updated_at,
              COALESCE(points_redeemed, 0)::int AS points_redeemed,
              COALESCE(reward_discount_azn, 0)::numeric AS reward_discount_azn,
         COALESCE(membership_discount_azn, 0)::numeric AS membership_discount_azn,
         promo_code,
              COALESCE(promo_discount_azn, 0)::numeric AS promo_discount_azn,
         promo_label,
              COALESCE(points_earned, 0)::int AS points_earned
       FROM orders WHERE id = $1`,
      [id]
    );
    if (!result.rows[0]) return null;
    const order = formatOrderRow(result.rows[0]);
    try {
      const statusHistory = await pool.query(
        `SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at ASC`,
        [id]
      );
      order.status_history = (statusHistory.rows || []).map((row: Record<string, unknown>) => ({
        status: toStr(row.status),
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : toStr(row.created_at),
      }));
    } catch {
      order.status_history = [];
    }
    return order;
  } catch (err) {
    console.error('getOrderById error:', err);
    return null;
  }
}

export async function getOrdersByCustomerId(customerId: number): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, order_number, customer_id, customer_name, mobile, membership_level,
            address, items, total_price, order_date, delivery_due_date, status, created_at, updated_at,
            COALESCE(points_redeemed, 0)::int AS points_redeemed,
            COALESCE(reward_discount_azn, 0)::numeric AS reward_discount_azn,
            COALESCE(membership_discount_azn, 0)::numeric AS membership_discount_azn,
            promo_code,
            COALESCE(promo_discount_azn, 0)::numeric AS promo_discount_azn,
            promo_label,
            COALESCE(points_earned, 0)::int AS points_earned
     FROM orders WHERE customer_id = $1 ORDER BY order_date DESC`,
    [customerId]
  );
  return result.rows.map(row => formatOrderRow(row));
}

export async function updateOrderStatus(
  orderId: string,
  status: typeof ALLOWED_STATUSES[number]
): Promise<Record<string, unknown> | null> {
  const order = await getOrderById(orderId);
  if (!order) return null;
  await pool.query(
    `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, orderId]
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)`,
    [orderId, status]
  );
  return getOrderById(orderId);
}

export function isAllowedStatus(status: string): status is typeof ALLOWED_STATUSES[number] {
  return ALLOWED_STATUSES.includes(status as typeof ALLOWED_STATUSES[number]);
}

function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function formatOrderRow(row: Record<string, unknown>): Record<string, unknown> {
  const orderDate = row.order_date;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  const deliveredAt = row.delivered_at;
  return {
    id: toStr(row.id),
    order_number: toStr(row.order_number),
    customer_id: row.customer_id != null ? Number(row.customer_id) : null,
    customer_name: toStr(row.customer_name),
    mobile: toStr(row.mobile),
    membership_level: toStr(row.membership_level) || 'none',
    address: row.address != null && row.address !== '' ? toStr(row.address) : null,
    items: Array.isArray(row.items) ? row.items : [],
    total_price: Number(row.total_price) || 0,
    order_date: orderDate instanceof Date ? orderDate.toISOString() : toStr(orderDate),
    delivery_due_date: row.delivery_due_date != null && row.delivery_due_date !== '' ? toStr(row.delivery_due_date) : null,
    delivered_at: deliveredAt != null && deliveredAt !== '' ? (deliveredAt instanceof Date ? deliveredAt.toISOString() : toStr(deliveredAt)) : null,
    status: toStr(row.status) || 'NEW',
    points_earned: row.points_earned != null ? Number(row.points_earned) : 0,
    points_redeemed: row.points_redeemed != null ? Number(row.points_redeemed) : 0,
    reward_discount_azn: row.reward_discount_azn != null ? Number(row.reward_discount_azn) : 0,
    promo_code: row.promo_code != null && row.promo_code !== '' ? toStr(row.promo_code) : null,
    promo_discount_azn: row.promo_discount_azn != null ? Number(row.promo_discount_azn) : 0,
    promo_label: row.promo_label != null && row.promo_label !== '' ? toStr(row.promo_label) : null,
    membership_discount_azn: row.membership_discount_azn != null ? Number(row.membership_discount_azn) : 0,
    created_at: createdAt instanceof Date ? createdAt.toISOString() : toStr(createdAt),
    updated_at: updatedAt instanceof Date ? updatedAt.toISOString() : toStr(updatedAt),
  };
}

export async function getOrderStats(): Promise<{ status: string; count: number }[]> {
  const result = await pool.query(
    `SELECT status, count(*)::int AS count FROM orders GROUP BY status ORDER BY status`
  );
  return result.rows;
}
