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
  promo_code?: string | null;
  promo_discount_azn?: number;
  promo_label?: string | null;
  promo_error_code?: string | null;
  membershipCatalogFraction: number;
  membershipLevelName: string | null;
  /** When shipping came from delivery_country + checkout_currency policy (not summed from __delivery__ lines). */
  shippingSource?: 'policy' | 'lines';
  shippingZone?: ShippingZone | null;
  checkoutCurrencyResolved?: CheckoutCurrency | null;
  /** International total shipping in USD (base + per-extra-unit surcharge). */
  shippingInternationalFeeUsd?: number | null;
  shippingInternationalBaseFeeUsd?: number | null;
  shippingInternationalSurchargeUsd?: number | null;
  /** Resolved $/merchandise unit after first (international). */
  shippingInternationalExtraUsdPerUnit?: number | null;
  shippingMerchandiseUnits?: number | null;
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
function norm(v?: string | null): string | null {
  const s = String(v ?? '').trim();
  return s ? s.toUpperCase() : null;
}

function ci(list: unknown): string[] {
  return Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
}

function canUse(list: unknown, value: string | null | undefined): boolean {
  const allow = ci(list);
  if (allow.length === 0) return true;
  const v = String(value ?? '').trim().toLowerCase();
  return !!v && allow.includes(v);
}

export async function applyPromoToBreakdown(
    base: CheckoutBreakdown,
    args: {
      promoCode?: string | null;
      customerId?: number | null;
      membershipLevelName?: string | null;
      mobile?: string | null;
      email?: string | null;
      city?: string | null;
      country?: string | null;
      lockUsage?: boolean;
      client?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
    }
): Promise<CheckoutBreakdown> {
  const code = norm(args.promoCode);
  if (!code) return { ...base, promo_code: null, promo_discount_azn: 0, promo_label: null, promo_error_code: null };

  const q = args.client ?? pool;
  const rowRes = await q.query(
      `SELECT *
     FROM promo_codes
     WHERE UPPER(code) = $1
     LIMIT 1`,
      [code]
  );
  const p = rowRes.rows[0];
  if (!p) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: null, promo_error_code: 'INVALID_PROMO_CODE' };

  const now = new Date();
  if (p.is_active !== true) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_INACTIVE' };
  if (p.starts_at && now < new Date(String(p.starts_at))) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_STARTED' };
  if (p.ends_at && now > new Date(String(p.ends_at))) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_EXPIRED' };

  const cid = Number(args.customerId);
  const maxTotal = Number(p.max_total_uses);
  if (args.lockUsage && Number.isFinite(maxTotal) && maxTotal > 0) {
    const used = await q.query(`SELECT COUNT(*)::int AS n FROM promo_code_redemptions WHERE promo_id = $1`, [p.id]);
    if ((Number(used.rows[0]?.n) || 0) >= maxTotal) {
      return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_USAGE_LIMIT_REACHED' };
    }
  }

  const maxPer = Number(p.max_uses_per_customer);
  if (args.lockUsage && Number.isFinite(cid) && cid > 0 && Number.isFinite(maxPer) && maxPer > 0) {
    const used = await q.query(
        `SELECT COUNT(*)::int AS n FROM promo_code_redemptions WHERE promo_id = $1 AND customer_id = $2`,
        [p.id, cid]
    );
    if ((Number(used.rows[0]?.n) || 0) >= maxPer) {
      return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_PER_ACCOUNT_LIMIT_REACHED' };
    }
  }

  if (!canUse(p.eligible_membership_levels, args.membershipLevelName)) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_ELIGIBLE' };
  if (!canUse(p.eligible_emails, args.email)) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_ELIGIBLE' };
  if (!canUse(p.eligible_mobiles, args.mobile)) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_ELIGIBLE' };
  if (!canUse(p.eligible_cities, args.city)) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_ELIGIBLE' };
  if (!canUse(p.eligible_countries, args.country)) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_ELIGIBLE' };

  if (Array.isArray(p.eligible_customer_ids) && p.eligible_customer_ids.length > 0) {
    const allowIds = p.eligible_customer_ids.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n));
    if (!Number.isFinite(cid) || !allowIds.includes(cid)) {
      return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_ELIGIBLE' };
    }
  }

  if (p.combinable_with_membership === false && base.membershipDiscountAzn > 0) {
    return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_COMBINABLE' };
  }
  if (p.combinable_with_points === false && base.pointsDiscountAzn > 0) {
    return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_NOT_COMBINABLE' };
  }

  const discountType = String(p.discount_type ?? '').toLowerCase();
  const discountValue = Number(p.discount_value) || 0;
  const cap = Number(p.discount_cap_azn) || 0;
  const floor = Number(p.min_merchandise_azn) || 0;

  const fullPriceAfterMembership = round2(
      Math.max(0, Number(base.membershipEligibleSubtotalAzn) - Number(base.membershipDiscountAzn))
  );
  const promoBaseSource =
      p.combinable_with_site_discounts === false ? fullPriceAfterMembership : Number(base.merchandiseAfterMembershipAzn);
  const promoBase = round2(Math.max(0, promoBaseSource - Number(base.pointsDiscountAzn)));
  if (promoBase < floor) return { ...base, promo_code: code, promo_discount_azn: 0, promo_label: String(p.label ?? ''), promo_error_code: 'PROMO_MIN_NOT_MET' };

  let promoDiscount = 0;
  if (discountType === 'percent') promoDiscount = round2((promoBase * discountValue) / 100);
  if (discountType === 'fixed') promoDiscount = round2(discountValue);

  if (cap > 0) promoDiscount = Math.min(promoDiscount, cap);
  promoDiscount = round2(Math.min(Math.max(0, promoDiscount), promoBase));

  return {
    ...base,
    promo_code: code,
    promo_discount_azn: promoDiscount,
    promo_label: String(p.label ?? ''),
    promo_error_code: null,
    payableTotalAzn: round2(
        Math.max(0, Number(base.merchandiseAfterMembershipAzn) - Number(base.pointsDiscountAzn) - promoDiscount) +
        Number(base.shippingAzn)
    ),
  };
}

export async function recordPromoRedemption(args: {
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  promoCode: string;
  orderId: string;
  customerId?: number | null;
  promoDiscountAzn: number;
}): Promise<void> {
  const code = norm(args.promoCode);
  if (!code || args.promoDiscountAzn <= 0) return;

  const p = await args.client.query(`SELECT id FROM promo_codes WHERE UPPER(code) = $1 LIMIT 1`, [code]);
  const promoId = Number(p.rows[0]?.id);
  if (!Number.isFinite(promoId) || promoId <= 0) return;

  await args.client.query(
      `INSERT INTO promo_code_redemptions (promo_id, customer_id, order_id, discount_azn)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_id) DO NOTHING`,
      [
        promoId,
        args.customerId != null && Number.isFinite(Number(args.customerId)) ? Number(args.customerId) : null,
        args.orderId,
        round2(args.promoDiscountAzn),
      ]
  );
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
    shippingInternationalBaseFeeUsd: shipRes.source === 'policy' ? shipRes.internationalBaseFeeUsd ?? null : null,
    shippingInternationalSurchargeUsd: shipRes.source === 'policy' ? shipRes.internationalSurchargeUsd ?? null : null,
    shippingInternationalExtraUsdPerUnit: shipRes.source === 'policy' ? shipRes.internationalExtraUsdPerUnit ?? null : null,
    shippingMerchandiseUnits: shipRes.source === 'policy' ? shipRes.merchandiseUnits ?? null : null,
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
  promo_code?: string | null;
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
  let customerEmail: string | null = null;
  let customerMobile: string | null = null;
  let customerCity: string | null = null;
  let customerCountry: string | null = null;

  if (cid) {
    const c = await pool.query(
        `SELECT
         NULLIF(TRIM(email), '') AS email,
         NULLIF(TRIM(phone), '') AS phone,
         NULLIF(TRIM(city), '') AS city,
         NULLIF(TRIM(country), '') AS country
       FROM customers
       WHERE id = $1
       LIMIT 1`,
        [cid]
    );
    customerEmail = (c.rows[0]?.email as string | null) ?? null;
    customerMobile = (c.rows[0]?.phone as string | null) ?? null;
    customerCity = (c.rows[0]?.city as string | null) ?? null;
    customerCountry = (c.rows[0]?.country as string | null) ?? null;
  }

  const base = computeCheckoutBreakdown({
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

  return applyPromoToBreakdown(base, {
    promoCode: order.promo_code,
    customerId: cid,
    membershipLevelName: levelName,
    email: customerEmail,
    mobile: customerMobile,
    city: order.delivery_city ?? customerCity,
    country: order.delivery_country ?? customerCountry,
    lockUsage: false,
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
      shippingInternationalBaseFeeUsd: breakdown.shippingInternationalBaseFeeUsd,
      shippingInternationalSurchargeUsd: breakdown.shippingInternationalSurchargeUsd,
      shippingInternationalExtraUsdPerUnit: breakdown.shippingInternationalExtraUsdPerUnit,
      shippingMerchandiseUnits: breakdown.shippingMerchandiseUnits,
      shippingDomesticFeeAzn: breakdown.shippingDomesticFeeAzn,
      shippingQuoteAmount: breakdown.shippingQuoteAmount,
      shippingQuoteCurrency: breakdown.shippingQuoteCurrency,
      shippingCountryIso2: breakdown.shippingCountryIso2,
      pointsDiscountAzn: breakdown.pointsDiscountAzn,
      pointsRedeemed: breakdown.pointsRedeemed,
      expectedPayableAzn: breakdown.payableTotalAzn,
      promo_code: breakdown.promo_code ?? null,
      promo_discount_azn: breakdown.promo_discount_azn ?? 0,
      promo_label: breakdown.promo_label ?? null,
      promo_error_code: breakdown.promo_error_code ?? null,
      membershipLevelName: breakdown.membershipLevelName,
      membershipCatalogFraction: breakdown.membershipCatalogFraction,
    },
  };
}
