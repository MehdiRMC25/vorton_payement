import nodemailer from 'nodemailer';
import { config } from '../config';
import { getCustomerByIdSafe } from './customerService';

/** Order shape from orderService (formatOrderRow / getOrderById). */
interface OrderForEmail {
  id?: string;
  order_number?: string;
  customer_id?: number | null;
  customer_name?: string;
  mobile?: string;
  membership_level?: string;
  address?: string | null;
  items?: Array<{ name?: string; quantity?: number; price?: number; sku_color?: string; size?: string; [key: string]: unknown }>;
  total_price?: number;
  order_date?: string;
  delivery_due_date?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

function buildOrderEmailBody(order: OrderForEmail): string {
  const items = order.items ?? [];
  const lines: string[] = [
    `Order: ${order.order_number ?? order.id ?? 'N/A'}`,
    `Status: ${order.status ?? 'NEW'}`,
    `Date: ${order.order_date ?? order.created_at ?? 'N/A'}`,
    '',
    '--- Customer ---',
    `Name: ${order.customer_name ?? 'N/A'}`,
    `Mobile: ${order.mobile ?? 'N/A'}`,
    `Membership: ${order.membership_level ?? 'none'}`,
    `Address: ${order.address ?? 'N/A'}`,
    '',
    '--- Items ---',
  ];
  items.forEach((item, i) => {
    const name = item.name ?? 'Unknown';
    const qty = item.quantity ?? 0;
    const price = item.price ?? 0;
    const color = item.sku_color ? ` (${item.sku_color})` : '';
    const size = item.size ? ` / ${item.size}` : '';
    lines.push(`${i + 1}. ${name}${color}${size} — Qty: ${qty} × ${Number(price).toFixed(2)} AZN`);
  });
  lines.push('');
  lines.push(`Total: ${Number(order.total_price ?? 0).toFixed(2)} AZN`);
  if (order.delivery_due_date) {
    lines.push(`Delivery due: ${order.delivery_due_date}`);
  }
  return lines.join('\r\n');
}

function buildCustomerOrderEmailBody(order: OrderForEmail): string {
  const items = order.items ?? [];
  const lines: string[] = [
    `Thank you for your purchase from Vorton.`,
    '',
    `Order: ${order.order_number ?? order.id ?? 'N/A'}`,
    `Date: ${order.order_date ?? order.created_at ?? 'N/A'}`,
    '',
    '--- Items ---',
  ];
  items.forEach((item, i) => {
    const name = item.name ?? 'Unknown';
    const qty = item.quantity ?? 0;
    const price = item.price ?? 0;
    const color = item.sku_color ? ` (${item.sku_color})` : '';
    const size = item.size ? ` / ${item.size}` : '';
    // Storefront totals are in AZN in this backend
    lines.push(`${i + 1}. ${name}${color}${size} — Qty: ${qty} × ${Number(price).toFixed(2)} AZN`);
  });
  lines.push('');
  lines.push(`Total: ${Number(order.total_price ?? 0).toFixed(2)} AZN`);
  if (order.delivery_due_date) {
    lines.push(`Delivery due: ${order.delivery_due_date}`);
  }
  lines.push('');
  lines.push('If you did not place this order, please contact support.');
  return lines.join('\r\n');
}

/**
 * Outbound SMTP: staff order alerts (EMAIL_TO), customer purchase confirmations (To = account emails),
 * and profile email verification codes — all use config.email (EMAIL_* / EMAIL_FROM, e.g. bot@vorton.uk).
 */
/**
 * Send a one-time code to verify a new email address (profile change).
 */
export async function sendEmailChangeCode(to: string, code: string): Promise<boolean> {
  const { host, port, user, pass, fromOtp } = config.email;
  if (!host || !user || !pass) {
    console.warn('[Email] Skipping email change code: EMAIL_HOST, EMAIL_USER, EMAIL_PASS not configured');
    return false;
  }
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await transporter.sendMail({
      from: fromOtp || user,
      to,
      subject: '[Vorton] Verify your new email address',
      text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes. If you did not request this, you can ignore this email.`,
    });
    console.log('[Email] Email change code sent to', to);
    return true;
  } catch (err) {
    console.error('[Email] Email change code failed:', err);
    return false;
  }
}

export async function sendOrderNotification(order: OrderForEmail): Promise<boolean> {
  const { host, port, user, pass, fromOrders, to } = config.email;
  if (!host || !user || !pass) {
    console.warn('[Email] Skipping order notification: EMAIL_HOST, EMAIL_USER, EMAIL_PASS not configured');
    return false;
  }
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await transporter.sendMail({
      from: fromOrders || user,
      to: to || 'neworder@vorton.uk',
      subject: `[Vorton] New Order ${order.order_number ?? order.id ?? ''}`,
      text: buildOrderEmailBody(order),
    });
    console.log('[Email] Order notification sent to', to);
    return true;
  } catch (err) {
    console.error('[Email] Order notification failed:', err);
    return false;
  }
}

/** Send purchase confirmation to customer emails on their account (same SMTP as staff / OTP — EMAIL_*). */
export async function sendCustomerPurchaseConfirmation(order: OrderForEmail): Promise<boolean> {
  const customerId =
      typeof order.customer_id === 'number' && Number.isFinite(order.customer_id) ? order.customer_id : null;
  if (!customerId) return false;

  const u = await getCustomerByIdSafe(customerId);
  const emails = [u?.email, u?.second_email, u?.third_email]
      .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
      .filter((e) => Boolean(e));
  const unique = Array.from(new Set(emails));
  if (unique.length === 0) return false;

  const { host, port, user, pass, fromOrders } = config.email;
  if (!host || !user || !pass) {
    console.warn('[Email] Skipping customer purchase confirmation: EMAIL_HOST, EMAIL_USER, EMAIL_PASS not configured');
    return false;
  }

  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await transporter.sendMail({
      from: fromOrders || user,
      to: unique.join(', '),
      subject: `Vorton order confirmation ${order.order_number ?? ''}`.trim(),
      text: buildCustomerOrderEmailBody(order),
    });

    console.log('[Email] Customer confirmation sent to', unique.join(', '));
    return true;
  } catch (err) {
    console.error('[Email] Customer confirmation failed:', err);
    return false;
  }
}
