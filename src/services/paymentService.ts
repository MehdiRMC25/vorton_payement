import { config } from '../config';
import { createOrder, buildRedirectUrl } from './kapitalService';
import { pool } from '../db';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

/** Optional: when payment confirms as FullyPaid, backend creates this order so it appears on Delivery and Order Track. */
export interface PendingOrderPayload {
  customer_id?: number;
  customer_name: string;
  mobile: string;
  membership_level?: string;
  address?: string | null;
  items: Array<{ name: string; quantity: number; price: number; product_id?: string; sku_color?: string; size?: string; [key: string]: unknown }>;
  total_price: number;
  delivery_due_date?: string | null;
}

export interface CreatePaymentInput {
  amount: number;
  currency: string;
  orderId?: string;
  reference?: string;
  customerId?: string;
  customerEmail?: string;
  returnUrl?: string;
  cancelUrl?: string;
  language?: string;
  metadata?: Record<string, string>;
  /** If provided, when payment confirms as FullyPaid the backend will create this order (POST /orders) so it appears on Delivery and Order Track. */
  order?: PendingOrderPayload;
}

export interface PaymentIntent {
  paymentId: string;
  orderId?: string;
  bankOrderId?: string;
  bankOrderSecret?: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'cancelled';
  amount: number;
  currency: string;
  reference?: string;
  clientSecret?: string;
  redirectUrl?: string;
  paymentUrl?: string;
  createdAt: string;
  /** Stored from create; used to create order when payment confirms as succeeded. */
  orderPayload?: PendingOrderPayload;
}

const payments = new Map<string, PaymentIntent>();
const byBankOrderId = new Map<string, string>();

export async function createPaymentIntent(input: CreatePaymentInput): Promise<PaymentIntent> {
  const { bank } = config;
  const useRealBank = Boolean(bank.gatewayUrl && bank.username && bank.password);

  if (useRealBank) {
    const redirectAfterPayment = input.returnUrl?.trim() || bank.callbackUrl?.trim();
    if (!redirectAfterPayment) {
      throw new Error('returnUrl (in request) or CALLBACK_URL (in .env) is required when using Kapital Bank');
    }
    const order = await createOrder({
      amount: input.amount,
      currency: input.currency,
      language: input.language,
      description: input.reference ?? 'Payment',
      hppRedirectUrl: redirectAfterPayment,
    });
    const paymentUrl = buildRedirectUrl(order);
    const paymentId = generateId();
    const intent: PaymentIntent = {
      paymentId,
      orderId: input.orderId,
      bankOrderId: order.id,
      bankOrderSecret: order.secret,
      status: 'pending',
      amount: input.amount,
      currency: input.currency,
      reference: input.reference,
      redirectUrl: paymentUrl,
      paymentUrl,
      createdAt: new Date().toISOString(),
      orderPayload: input.order ?? undefined,
    };
    payments.set(paymentId, intent);
    if (order.id) byBankOrderId.set(order.id, paymentId);
    persistPaymentIntent(intent).catch((e) => console.warn('[Payment] Could not persist payment:', e));
    return intent;
  }

  const paymentId = generateId();
  const intent: PaymentIntent = {
    paymentId,
    orderId: input.orderId,
    status: 'pending',
    amount: input.amount,
    currency: input.currency,
    reference: input.reference,
    clientSecret: 'demo_secret_' + generateId(),
    createdAt: new Date().toISOString(),
    orderPayload: input.order ?? undefined,
  };
  payments.set(paymentId, intent);
  return intent;
}

export async function getPaymentStatus(paymentId: string): Promise<PaymentIntent | null> {
  return payments.get(paymentId) ?? null;
}

/** Persist payment to DB so order creation survives server restarts (e.g. Render cold start). */
async function persistPaymentIntent(intent: PaymentIntent): Promise<void> {
  if (!intent.bankOrderId || !intent.orderPayload) return;
  try {
    await pool.query(
      `INSERT INTO payment_intents (payment_id, bank_order_id, bank_order_secret, status, amount, currency, order_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (bank_order_id) DO UPDATE SET order_payload = EXCLUDED.order_payload, status = EXCLUDED.status`,
      [
        intent.paymentId,
        intent.bankOrderId,
        intent.bankOrderSecret ?? null,
        intent.status,
        intent.amount,
        intent.currency,
        JSON.stringify(intent.orderPayload),
      ]
    );
  } catch {
    // Table may not exist; persistPaymentIntent is best-effort
  }
}

/** Look up payment by bank order ID from DB (used when in-memory map was lost on restart). */
export async function getPaymentByBankOrderIdFromDb(bankOrderId: string): Promise<PaymentIntent | null> {
  try {
    const result = await pool.query(
      `SELECT payment_id, bank_order_id, bank_order_secret, status, amount, currency, order_payload, created_at
       FROM payment_intents WHERE bank_order_id = $1 LIMIT 1`,
      [bankOrderId]
    );
    const row = result.rows[0];
    if (!row || !row.order_payload) return null;
    const payload = row.order_payload as PendingOrderPayload;
    return {
      paymentId: String(row.payment_id),
      bankOrderId: String(row.bank_order_id),
      bankOrderSecret: row.bank_order_secret ? String(row.bank_order_secret) : undefined,
      status: String(row.status) as PaymentIntent['status'],
      amount: Number(row.amount) || 0,
      currency: String(row.currency) || 'AZN',
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      orderPayload: payload,
    };
  } catch {
    return null;
  }
}

export function getPaymentByBankOrderId(bankOrderId: string): PaymentIntent | null {
  const paymentId = byBankOrderId.get(bankOrderId);
  return paymentId ? payments.get(paymentId) ?? null : null;
}

const KAPITAL_STATUS_MAP: Record<string, PaymentIntent['status']> = {
  FullyPaid: 'succeeded',
  Paid: 'succeeded',
  Success: 'succeeded',
  Failed: 'failed',
  Rejected: 'failed',
  Cancelled: 'cancelled',
  Canceled: 'cancelled',
  Pending: 'pending',
  Preparing: 'pending',
};

export function confirmPaymentByBankOrder(bankOrderId: string, kapitalStatus: string): PaymentIntent | null {
  const paymentId = byBankOrderId.get(bankOrderId);
  if (!paymentId) return null;
  const p = payments.get(paymentId);
  if (!p) return null;
  const status = KAPITAL_STATUS_MAP[kapitalStatus] ?? (kapitalStatus ? 'pending' : p.status);
  p.status = status;
  payments.set(paymentId, p);
  return p;
}

/** Update payment status (in memory and DB). Used when payment may have been loaded from DB after restart. */
export async function confirmAndPersistPaymentStatus(
  payment: PaymentIntent,
  kapitalStatus: string
): Promise<PaymentIntent> {
  const status = KAPITAL_STATUS_MAP[kapitalStatus] ?? (kapitalStatus ? 'pending' : payment.status);
  payment.status = status;
  // Keep in-memory in sync if present
  const paymentId = payment.bankOrderId ? byBankOrderId.get(payment.bankOrderId) : null;
  if (paymentId) {
    payments.set(paymentId, payment);
  }
  // Persist to DB so status is updated
  if (payment.bankOrderId) {
    try {
      await pool.query(
        `UPDATE payment_intents SET status = $1 WHERE bank_order_id = $2`,
        [status, payment.bankOrderId]
      );
    } catch (e) {
      console.warn('[Payment] Could not update payment status in DB:', e);
    }
  }
  return payment;
}

export function updatePaymentStatus(paymentId: string, status: PaymentIntent['status']): void {
  const p = payments.get(paymentId);
  if (p) {
    p.status = status;
    payments.set(paymentId, p);
  }
}
