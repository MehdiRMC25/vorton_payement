import { config } from '../config';
import { createOrder, buildRedirectUrl } from './kapitalService';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
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
    };
    payments.set(paymentId, intent);
    if (order.id) byBankOrderId.set(order.id, paymentId);
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
  };
  payments.set(paymentId, intent);
  return intent;
}

export async function getPaymentStatus(paymentId: string): Promise<PaymentIntent | null> {
  return payments.get(paymentId) ?? null;
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

export function updatePaymentStatus(paymentId: string, status: PaymentIntent['status']): void {
  const p = payments.get(paymentId);
  if (p) {
    p.status = status;
    payments.set(paymentId, p);
  }
}
