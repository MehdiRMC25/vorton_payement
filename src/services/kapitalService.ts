import { config } from '../config';

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
 */
export async function createOrder(params: KapitalCreateOrderParams): Promise<KapitalOrderResponse> {
  const { bank } = config;
  const baseUrl = bank.gatewayUrl.replace(/\/$/, '');
  const url = `${baseUrl}/order/`;
  const credentials = Buffer.from(`${bank.username}:${bank.password}`, 'utf8').toString('base64');
  const body = {
    typeRid: 'Order_SMS',
    amount: params.amount,
    currency: params.currency,
    language: params.language ?? 'en',
    description: params.description ?? 'Payment',
    hppRedirectUrl: params.hppRedirectUrl,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kapital Bank error (${res.status}): ${text}`);
  }
  return res.json() as Promise<KapitalOrderResponse>;
}

/** Build the URL to redirect the user to Kapital HPP (Hosted Payment Page). */
export function buildRedirectUrl(order: KapitalOrderResponse): string {
  return `${order.hppUrl}/flex?id=${order.id}&password=${order.password}`;
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
