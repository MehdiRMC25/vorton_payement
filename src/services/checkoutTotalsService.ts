/**
 * Authoritative checkout totals: membership catalog discount, points redemption, shipping.
 * Used by payment create, order create, and POST /checkout/preview.
 */
import { pool } from '../db';
import type { OrderItem } from './orderService';
import { getCustomerMembership } from './membershipService';
import { isShippingLine, validateRedemptionRequest } from './rewardPointsPolicy';
import { resolveShippingAmount, type ShippingZone, type CheckoutCurrency } from './shippingPolicy';

export const CHECKOUT_AMOUNT_EPS = 0.03;

export interface CheckoutBreakdown {
  /** Sum(qty × unit) for non-shipping lines using promo unit when line is promotional, else list unit — before membership. */
  merchandiseSubtotalBeforeMembershipAzn: number;
  /** Sum(qty × list unit) on catalogue (non-promo) lines only — base for membership %. */
  membershipEligibleSubtotalAzn: number;
  membershipDiscountAzn: number;
  /** Merchandise after membership, excluding shipping (before points). */
  merchandiseAfterMembershipAzn: number;
  shippingAzn: number;
  pointsRedeemed: number;
  pointsDiscountAzn: number;
  /** Amount to charge: (merchandise after membership − points) + shipping */
  payableTotalAzn: number;
  membershipCatalogFraction: number;
  membershipLevelName: string | null;
  /** When shipping came from delivery_country + checkout_currency policy (not summed from __delivery__ lines). */
  shippingSource?: 'policy' | 'lines';
  shippingZone?: ShippingZone | null;
  checkoutCurrencyResolved?: CheckoutCurrency | null;
  /** International row from config (USD). */
  shippingInternationalFeeUsd?: number | null;
  /** Azerbaijan domestic base in AZN (5 or 10). */
  shippingDomesticFeeAzn?: number | null;
  /** UI display amount for selected checkout currency (see shipping policy). */
  shippingQuoteAmount?: number | null;
  shippingQuoteCurrency?: CheckoutCurrency | null;
  shippingCountryIso2?: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function listUnit(it: OrderItem & Record<string, unknown>): number {
  return Number(it.price) || 0;
}

function promoUnit(it: OrderItem & Record<string, unknown>): number | null {
  const d =
    it.discountedPrice ??
    it.discounted_price ??
    (typeof it.discountedPrice === 'number' ? it.discountedPrice : undefined);
  if (d == null || d === '') return null;
  const n = Number(d);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Promotional line: cheaper promo unit strictly below list, or explicit promo/discount flags (same rule as mobile). */
export function isPromotionalMerchandiseLine(it: OrderItem & Record<string, unknown>): boolean {
  if (isShippingLine(it)) return false;
  if (it.promotional === true || String(it.promotional) === 'true') return true;
  if (it.is_discounted === true || String(it.is_discounted) === 'true') return true;
  const list = listUnit(it);
  if (list <= 0) return false;
  const p = promoUnit(it);
  if (p == null) return false;
  return p < list - 0.0001;
}

/** Full-price catalogue line: membership % applies to list × qty. */
function isCatalogueLineForMembership(it: OrderItem & Record<string, unknown>): boolean {
  if (isShippingLine(it)) return false;
  if (it.promotional === true || String(it.promotional) === 'true') return false;
  if (it.is_discounted === true || String(it.is_discounted) === 'true') return false;
  if (isPromotionalMerchandiseLine(it)) return false;
  return true;
}

function effectiveUnitMerchandise(it: OrderItem & Record<string, unknown>): number {
  if (isShippingLine(it)) return 0;
  if (isPromotionalMerchandiseLine(it)) {
    const p = promoUnit(it);
    if (p != null) return p;
    return listUnit(it);
  }
  return listUnit(it);
}

/**
 * Catalog discount fraction by tier name; falls back to DB discount_percent / 100 when name unknown.
 * Policy: Silver 3%, Gold 5%, Platinum 8%, Platinum+ 10%.
 */
export function membershipCatalogDiscountFraction(
  levelName: string | null | undefined,
  dbDiscountPercent?: number | null
): number {
  if (!levelName || !String(levelName).trim()) {
    if (dbDiscountPercent != null && Number.isFinite(dbDiscountPercent) && dbDiscountPercent > 0 && dbDiscountPercent <= 100) {
      return dbDiscountPercent / 100;
    }
    return 0;
  }
  const raw = String(levelName).toLowerCase().replace(/[\s-]+/g, '_');
  if (raw.includes('platinum') && (raw.includes('plus') || raw.includes('+'))) return 0.1;
  if (raw.includes('platinum')) return 0.08;
  if (raw.includes('gold')) return 0.05;
  if (raw.includes('silver')) return 0.03;
  if (dbDiscountPercent != null && Number.isFinite(dbDiscountPercent) && dbDiscountPercent > 0 && dbDiscountPercent <= 100) {
    return dbDiscountPercent / 100;
  }
  return 0;
}

export async function resolveMembershipForCustomer(
  customerId: number | null | undefined
): Promise<{ fraction: number; levelName: string | null }> {
  if (customerId == null || !Number.isFinite(customerId) || customerId <= 0) {
    return { fraction: 0, levelName: null };
  }
  try {
    const m = await getCustomerMembership(customerId);
    if (!m?.name) return { fraction: 0, levelName: null };
    const fraction = membershipCatalogDiscountFraction(m.name, m.discount_percent);
    return { fraction, levelName: m.name };
  } catch {
    return { fraction: 0, levelName: null };
  }
}

/**
 * Core calculation — all monetary policy in one place.
 * Points redemption base = merchandise after membership (excl. shipping), per stacking order.
 */
export function computeCheckoutBreakdown(params: {
  items: OrderItem[];
  pointsRequested: number;
  balancePoints: number;
  membershipCatalogFraction: number;
  membershipLevelName?: string | null;
  /** When country + checkout_currency are set, shipping uses zone table; else sums __delivery__ lines. */
  shipping?: {
    delivery_city?: string | null;
    delivery_country?: string | null;
    checkout_currency?: string | null;
  } | null;
}): CheckoutBreakdown {
  const items = params.items || [];
  let merchBefore = 0;
  let eligibleForMembership = 0;

  for (const raw of items) {
    const it = raw as OrderItem & Record<string, unknown>;
    if (isShippingLine(it)) continue;
    const qty = Number(it.quantity) || 0;
    const list = listUnit(it);
    const unit = effectiveUnitMerchandise(it);
    merchBefore += round2(qty * unit);
    if (isCatalogueLineForMembership(it)) {
      eligibleForMembership += round2(qty * list);
    }
  }

  merchBefore = round2(merchBefore);
  eligibleForMembership = round2(eligibleForMembership);

  const rate = Math.max(0, Math.min(1, params.membershipCatalogFraction));
  const membershipDiscountAzn = round2(eligibleForMembership * rate);
  const merchandiseAfterMembershipAzn = round2(merchBefore - membershipDiscountAzn);

  const shipRes = resolveShippingAmount(items, params.shipping);
  if (shipRes.source === 'unavailable') {
    const err = new Error('Delivery to the selected country is not available.') as Error & {
      code: string;
      payload: Record<string, unknown>;
    };
    err.code = 'SHIPPING_UNAVAILABLE';
    err.payload = {
      code: 'SHIPPING_UNAVAILABLE',
      error: 'Delivery to the selected country is not available.',
      countryIso2: shipRes.countryIso2,
      message: 'Delivery to your country is not available at this time.',
    };
    throw err;
  }
  const shippingAzn = shipRes.shippingAzn;
  const pts = Math.max(0, Math.floor(params.pointsRequested));

  let pointsRedeemed = 0;
  let pointsDiscountAzn = 0;
  if (pts > 0) {
    const v = validateRedemptionRequest(pts, merchandiseAfterMembershipAzn, params.balancePoints);
    if (!v.ok) {
      throw new Error(v.error);
    }
    pointsRedeemed = v.points;
    pointsDiscountAzn = v.discountAzn;
  }

  const payableTotalAzn = round2(merchandiseAfterMembershipAzn - pointsDiscountAzn + shippingAzn);

  return {
    merchandiseSubtotalBeforeMembershipAzn: merchBefore,
    membershipEligibleSubtotalAzn: eligibleForMembership,
    membershipDiscountAzn,
    merchandiseAfterMembershipAzn,
    shippingAzn,
    pointsRedeemed,
    pointsDiscountAzn,
    payableTotalAzn,
    membershipCatalogFraction: rate,
    membershipLevelName: params.membershipLevelName ?? null,
    shippingSource: shipRes.source,
    shippingZone: shipRes.source === 'policy' ? shipRes.zone : null,
    checkoutCurrencyResolved: shipRes.source === 'policy' ? shipRes.currency : null,
    shippingInternationalFeeUsd: shipRes.source === 'policy' ? shipRes.internationalFeeUsd : null,
    shippingDomesticFeeAzn: shipRes.source === 'policy' ? shipRes.domesticFeeAzn : null,
    shippingQuoteAmount: shipRes.source === 'policy' ? shipRes.shippingQuoteAmount : null,
    shippingQuoteCurrency: shipRes.source === 'policy' ? shipRes.shippingQuoteCurrency : null,
    shippingCountryIso2: shipRes.source === 'policy' ? shipRes.countryIso2 : null,
  };
}

export async function computeCheckoutBreakdownForPaymentOrder(order: {
  customer_id?: number;
  items: OrderItem[];
  points_to_redeem?: number;
  delivery_city?: string | null;
  delivery_country?: string | null;
  checkout_currency?: string | null;
}): Promise<CheckoutBreakdown> {
  const cid =
    order.customer_id != null && Number.isFinite(Number(order.customer_id)) ? Number(order.customer_id) : null;
  const pts = Math.max(0, Math.floor(Number(order.points_to_redeem) || 0));

  const { fraction, levelName } = await resolveMembershipForCustomer(cid);

  let balancePoints = 0;
  if (pts > 0) {
    if (!cid) {
      throw new Error('customer_id is required when redeeming reward points');
    }
    const r = await pool.query(`SELECT COALESCE(reward_points_balance, 0)::int AS b FROM customers WHERE id = $1`, [cid]);
    balancePoints = Number(r.rows[0]?.b) || 0;
  }

  return computeCheckoutBreakdown({
    items: order.items || [],
    pointsRequested: pts,
    balancePoints,
    membershipCatalogFraction: fraction,
    membershipLevelName: levelName,
    shipping: {
      delivery_city: order.delivery_city,
      delivery_country: order.delivery_country,
      checkout_currency: order.checkout_currency,
    },
  });
}

export function mismatchPayload(
  providedAmount: number,
  breakdown: CheckoutBreakdown,
  orderTotalPrice?: number
): Record<string, unknown> {
  return {
    error: 'PAYMENT_AMOUNT_MISMATCH',
    code: 'PAYMENT_AMOUNT_MISMATCH',
    provided: {
      amount: round2(Number(providedAmount)),
      order_total_price: orderTotalPrice != null ? round2(Number(orderTotalPrice)) : undefined,
    },
    computed: {
      merchandiseSubtotalBeforeMembershipAzn: breakdown.merchandiseSubtotalBeforeMembershipAzn,
      membershipEligibleSubtotalAzn: breakdown.membershipEligibleSubtotalAzn,
      membershipDiscountAzn: breakdown.membershipDiscountAzn,
      merchandiseAfterMembershipAzn: breakdown.merchandiseAfterMembershipAzn,
      shippingAzn: breakdown.shippingAzn,
      shippingSource: breakdown.shippingSource,
      shippingZone: breakdown.shippingZone,
      checkoutCurrencyResolved: breakdown.checkoutCurrencyResolved,
      shippingInternationalFeeUsd: breakdown.shippingInternationalFeeUsd,
      shippingDomesticFeeAzn: breakdown.shippingDomesticFeeAzn,
      shippingQuoteAmount: breakdown.shippingQuoteAmount,
      shippingQuoteCurrency: breakdown.shippingQuoteCurrency,
      shippingCountryIso2: breakdown.shippingCountryIso2,
      pointsDiscountAzn: breakdown.pointsDiscountAzn,
      pointsRedeemed: breakdown.pointsRedeemed,
      expectedPayableAzn: breakdown.payableTotalAzn,
      membershipLevelName: breakdown.membershipLevelName,
      membershipCatalogFraction: breakdown.membershipCatalogFraction,
    },
  };
}
