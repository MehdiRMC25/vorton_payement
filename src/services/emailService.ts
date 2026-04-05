import nodemailer from 'nodemailer';
import { config } from '../config';

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
    lines.push(`${i + 1}. ${name}${color}${size} — Qty: ${qty} × £${Number(price).toFixed(2)}`);
  });
  lines.push('');
  lines.push(`Total: £${Number(order.total_price ?? 0).toFixed(2)}`);
  if (order.delivery_due_date) {
    lines.push(`Delivery due: ${order.delivery_due_date}`);
  }
  return lines.join('\r\n');
}

/**
 * Send order notification to EMAIL_TO (orders@vorton.com).
 * From: EMAIL_FROM (bot@vorton.uk). Requires EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS.
 */
/**
 * Send a one-time code to verify a new email address (profile change).
 */
export async function sendEmailChangeCode(to: string, code: string): Promise<boolean> {
  const { host, port, user, pass, from } = config.email;
  if (!host || !user || !pass) {
    console.warn('[Email] Skipping email change code: EMAIL_HOST, EMAIL_USER, EMAIL_PASS not configured');
    return false;
  }
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await transporter.sendMail({
      from: from || user,
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
  const { host, port, user, pass, from, to } = config.email;
  if (!host || !user || !pass) {
    console.warn('[Email] Skipping order notification: EMAIL_HOST, EMAIL_USER, EMAIL_PASS not configured');
    return false;
  }
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await transporter.sendMail({
      from: from || user,
      to: to || 'orders@vorton.com',
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
