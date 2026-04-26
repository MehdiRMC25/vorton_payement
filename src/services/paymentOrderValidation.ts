import type { PendingOrderPayload } from './paymentService';
import type { OrderItem } from './orderService';
import {
  CHECKOUT_AMOUNT_EPS,
  computeCheckoutBreakdownForPaymentOrder,
  mismatchPayload,
  type CheckoutBreakdown,
} from './checkoutTotalsService';

export type { CheckoutBreakdown };

/**
 * Authoritative validation: recomputes membership, points, shipping from order payload + DB.
 * Returns breakdown on success; throws Error with message on validation failure.
 */
export async function validatePaymentAmountForOrder(
  amount: number,
  order: PendingOrderPayload
): Promise<CheckoutBreakdown> {
  const breakdown = await computeCheckoutBreakdownForPaymentOrder({
    customer_id: order.customer_id,
    items: (order.items || []) as OrderItem[],
    points_to_redeem: order.points_to_redeem,
    delivery_city: order.delivery_city,
    delivery_country: order.delivery_country,
    promo_code: order.promo_code,
    checkout_currency: order.checkout_currency,
  });
  if (Math.abs(Number(amount) - breakdown.payableTotalAzn) > CHECKOUT_AMOUNT_EPS) {
    const err = new Error('PAYMENT_AMOUNT_MISMATCH') as Error & { payload?: Record<string, unknown> };
    err.payload = mismatchPayload(amount, breakdown, order.total_price);
    throw err;
  }
  if (
    order.total_price != null &&
    Number.isFinite(Number(order.total_price)) &&
    Math.abs(Number(order.total_price) - breakdown.payableTotalAzn) > CHECKOUT_AMOUNT_EPS
  ) {
    const err = new Error('ORDER_TOTAL_PRICE_MISMATCH') as Error & { payload?: Record<string, unknown> };
    err.payload = mismatchPayload(amount, breakdown, order.total_price);
    throw err;
  }
  return breakdown;
}
