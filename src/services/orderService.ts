import { pool } from '../db';

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
  [key: string]: unknown;
}

export interface CreateOrderInput {
  customer_id?: number | null;
  customer_name: string;
  mobile: string;
  membership_level: string;
  address?: string | null;
  items: OrderItem[];
  total_price: number;
  delivery_due_date?: string | null;
}

function generateOrderNumber(): string {
  return 'ORD-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

export async function createOrder(input: CreateOrderInput): Promise<{ id: string; order_number: string }> {
  const order_number = generateOrderNumber();
  const result = await pool.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, mobile, membership_level,
      address, items, total_price, delivery_due_date, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::date, 'NEW')
    RETURNING id, order_number`,
    [
      order_number,
      input.customer_id ?? null,
      input.customer_name,
      input.mobile,
      input.membership_level || 'none',
      input.address ?? null,
      JSON.stringify(input.items || []),
      input.total_price,
      input.delivery_due_date ?? null,
    ]
  );
  const row = result.rows[0];
  await pool.query(
    `INSERT INTO order_status_history (order_id, status) VALUES ($1, 'NEW')`,
    [row.id]
  );
  return { id: row.id, order_number: row.order_number };
}

export async function getAllOrders(): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, order_number, customer_id, customer_name, mobile, membership_level,
            address, items, total_price, order_date, delivery_due_date, status, created_at, updated_at
     FROM orders ORDER BY order_date DESC`
  );
  return result.rows.map(row => formatOrderRow(row));
}

export async function getOrderById(id: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query(
    `SELECT id, order_number, customer_id, customer_name, mobile, membership_level,
            address, items, total_price, order_date, delivery_due_date, status, created_at, updated_at
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
}

export async function getOrdersByCustomerId(customerId: number): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, order_number, customer_id, customer_name, mobile, membership_level,
            address, items, total_price, order_date, delivery_due_date, status, created_at, updated_at
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
    status: toStr(row.status) || 'NEW',
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
