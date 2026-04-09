import type { PendingOrderPayload } from './paymentService';
import type { OrderItem } from './orderService';
import {
  discountAznFromRedeemPoints,
  merchandiseSubtotalExclShippingAznFromItems,
  shippingFeeAznFromItems,
} from './rewardPointsPolicy';

const EPS = 0.03;

/**
 * Ensures the bank charge matches merchandise total, or merchandise minus points discount.
 * Uses sum(items) as gross — do not trust client-only totals.
 */
export function assertPaymentAmountMatchesOrder(amount: number, order: PendingOrderPayload): void {
  const base = merchandiseSubtotalExclShippingAznFromItems((order.items || []) as OrderItem[]);
  const shipping = shippingFeeAznFromItems((order.items || []) as OrderItem[]);
  const gross = Math.round((base + shipping) * 100) / 100;
  const pts = Math.floor(Number(order.points_to_redeem) || 0);
  if (pts < 0) {
    throw new Error('Invalid points_to_redeem');
  }
  if (pts > 0 && (order.customer_id == null || !Number.isFinite(Number(order.customer_id)))) {
    throw new Error('customer_id is required when redeeming reward points');
  }
  const discount = discountAznFromRedeemPoints(pts);
  const net = Math.round(((base - discount) + shipping) * 100) / 100;
  const expected = pts > 0 ? net : gross;
  if (Math.abs(Number(amount) - expected) > EPS) {
    throw new Error(
      pts > 0
        ? 'Payment amount must equal (merchandise excl. shipping minus reward points discount) plus shipping'
        : 'Payment amount must match merchandise total'
    );
  }
}
