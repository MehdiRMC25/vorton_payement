import { config } from '../config';

/**
 * Never pass through raw HTML (e.g. Cloudflare 520 bodies) or huge payloads to API clients.
 */
function summarizeKapitalError(status: number, rawText: string): string {
  const t = rawText.trim();
  if (!t) {
    return `Kapital Bank request failed (HTTP ${status}). Please try again later.`;
  }
  if (/<!DOCTYPE|<\s*html/i.test(t)) {
    return `Kapital Bank is temporarily unavailable (HTTP ${status}). Please try again in a few minutes.`;
  }
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { message?: string; error?: string; detail?: string };
      const inner = [j.message, j.error, j.detail].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
      if (inner && !/<!DOCTYPE|<\s*html/i.test(inner) && inner.length < 400) {
        return `Kapital Bank (${status}): ${inner.trim()}`;
      }
    } catch {
      /* fall through */
    }
  }
  if (t.length > 280) {
    return `Kapital Bank returned an error (HTTP ${status}). Please try again later or contact support if this continues.`;
  }
  return `Kapital Bank error (${status}): ${t}`;
}

/** Kapital Bank Create Order request (Purchase - Order_SMS) */
export interface KapitalCreateOrderParams {
  amount: number;
  currency: string;
  language?: string;
  description?: string;
  hppRedirectUrl: string;
}

/** Kapital Bank Create Order response */
export interface KapitalOrderResponse {
  id: string;
  hppUrl: string;
  password: string;
  status?: string;
  cvv2AuthStatus?: string;
  secret?: string;
}

/**
 * Create a Purchase order (Order_SMS) with Kapital Bank E-commerce API.
 * Uses Basic Auth. Returns order id, HPP URL, and password for redirect.
 *
 * Per official docs (Ecommerce API Documentation Simple):
 * - Prod base: https://e-commerce.kapitalbank.az/api
 * - Test base: https://txpgtst.kapitalbank.az/api
 * - Create order: POST /order (relative to base)
 */
export async function createOrder(params: KapitalCreateOrderParams): Promise<KapitalOrderResponse> {
  const { bank } = config;
  // Normalize: base must end at /api, never include /order (avoids POST /order/order/ 404)
  const baseUrl = bank.gatewayUrl.replace(/\/order\/?$/, '').replace(/\/$/, '');
  const orderPath = (bank as { orderPath?: string }).orderPath?.replace(/^\//, '') || 'order';
  const url = `${baseUrl}/${orderPath}`;
  const credentials = Buffer.from(`${bank.username}:${bank.password}`, 'utf8').toString('base64');
  const requestBody = {
    order: {
      typeRid: 'Order_SMS',
      amount: params.amount,
      currency: params.currency,
      language: params.language ?? 'en',
      description: params.description ?? 'Payment',
      hppRedirectUrl: params.hppRedirectUrl,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[Kapital] POST failed', res.status, 'URL:', url, 'Response:', text.slice(0, 500));
    throw new Error(summarizeKapitalError(res.status, text));
  }
  const data = (await res.json()) as Record<string, unknown> & { order?: Record<string, unknown> };
  const raw: Record<string, unknown> =
    data && typeof data === 'object' && data.order && typeof data.order === 'object'
      ? data.order
      : data;
  const result: KapitalOrderResponse = {
    id: String(raw.id ?? ''),
    hppUrl: String(raw.hppUrl ?? raw.hpp_url ?? ''),
    password: String(raw.password ?? ''),
    status: raw.status != null ? String(raw.status) : undefined,
    secret: raw.secret != null ? String(raw.secret) : undefined,
  };
  return result;
}

/** Build the URL to redirect the user to Kapital HPP. One /flex only (hppUrl may already contain /flex). */
export function buildRedirectUrl(order: KapitalOrderResponse): string {
  const urlStr = order.hppUrl.startsWith('http') ? order.hppUrl : `https://${order.hppUrl}`;
  const origin = new URL(urlStr).origin;
  return `${origin}/flex?id=${encodeURIComponent(order.id)}&password=${encodeURIComponent(order.password)}`;
}

/**
 * Transaction Details request — verify payment status with Kapital (do not trust callback STATUS alone).
 * Doc: "STATUS can be temporary. Verify transaction status using a Transaction details request."
 * TODO: Replace with real Kapital API call when you have the endpoint from bank docs.
 */
export async function getTransactionDetails(bankOrderId: string): Promise<{ status: string } | null> {
  const { bank } = config;
  if (!bank.gatewayUrl || !bank.username || !bank.password) return null;
  // Stub: Kapital docs did not include the Transaction Details endpoint. When available, call it here
  // and return the verified status (e.g. FullyPaid / Failed). Until then we rely on callback STATUS.
  void bankOrderId;
  return null;
}
