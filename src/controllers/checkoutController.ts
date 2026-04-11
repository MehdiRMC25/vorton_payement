import { Request, Response } from 'express';
import { pool } from '../db';
import type { OrderItem } from '../services/orderService';
import {
  computeCheckoutBreakdown,
  resolveMembershipForCustomer,
  type CheckoutBreakdown,
} from '../services/checkoutTotalsService';

function previewJson(breakdown: CheckoutBreakdown, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    ...extra,
    breakdown: {
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
      pointsRedeemed: breakdown.pointsRedeemed,
      pointsDiscountAzn: breakdown.pointsDiscountAzn,
      payableTotalAzn: breakdown.payableTotalAzn,
      membershipLevelName: breakdown.membershipLevelName,
      membershipCatalogFraction: breakdown.membershipCatalogFraction,
    },
  };
}

function shippingFromBody(body: Record<string, unknown>) {
  const delivery_city =
    body.delivery_city != null ? String(body.delivery_city) : body.deliveryCity != null ? String(body.deliveryCity) : null;
  const delivery_country =
    body.delivery_country != null
      ? String(body.delivery_country)
      : body.deliveryCountry != null
        ? String(body.deliveryCountry)
        : null;
  const checkout_currency =
    body.checkout_currency != null
      ? String(body.checkout_currency)
      : body.checkoutCurrency != null
        ? String(body.checkoutCurrency)
        : null;
  return { delivery_city, delivery_country, checkout_currency };
}

/** POST /api/v1/checkout/preview — Bearer JWT. Same totals logic as payment create (for UI parity). */
export async function previewCheckout(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const items = Array.isArray(body.items) ? (body.items as OrderItem[]) : [];
    const ship = shippingFromBody(body);
    const ptsRaw = body.points_to_redeem;
    const pts =
      ptsRaw != null && ptsRaw !== '' ? Math.max(0, Math.floor(Number(ptsRaw))) : 0;
    if (!Number.isFinite(pts) || pts < 0) {
      res.status(400).json({ error: 'Invalid points_to_redeem' });
      return;
    }

    const { fraction, levelName } = await resolveMembershipForCustomer(uid);
    const balRes = await pool.query(
      `SELECT COALESCE(reward_points_balance, 0)::int AS b FROM customers WHERE id = $1`,
      [uid]
    );
    const balancePoints = Number(balRes.rows[0]?.b) || 0;

    const breakdown = computeCheckoutBreakdown({
      items,
      pointsRequested: pts,
      balancePoints,
      membershipCatalogFraction: fraction,
      membershipLevelName: levelName,
      shipping: ship,
    });

    res.json(previewJson(breakdown, { audience: 'member' }));
  } catch (e) {
    const typed = e as Error & { code?: string; payload?: Record<string, unknown> };
    if (typed.code === 'SHIPPING_UNAVAILABLE' && typed.payload && typeof typed.payload === 'object') {
      res.status(400).json(typed.payload);
      return;
    }
    const msg = e instanceof Error ? e.message : 'Checkout preview failed';
    res.status(400).json({ error: msg });
  }
}

/**
 * POST /api/v1/checkout/preview-guest — no auth.
 * Same breakdown shape as /preview; membership and points are always zero (settlement AZN only).
 */
export async function previewCheckoutGuest(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const items = Array.isArray(body.items) ? (body.items as OrderItem[]) : [];
    const ship = shippingFromBody(body);
    if (items.length === 0) {
      res.status(400).json({ error: 'items array is required' });
      return;
    }
    const ptsRaw = body.points_to_redeem;
    const ptsRequested =
      ptsRaw != null && ptsRaw !== '' ? Math.max(0, Math.floor(Number(ptsRaw))) : 0;
    if (ptsRequested > 0) {
      res.status(400).json({
        error: 'Points redemption requires a signed-in account. Omit points_to_redeem for guest checkout.',
      });
      return;
    }

    const breakdown = computeCheckoutBreakdown({
      items,
      pointsRequested: 0,
      balancePoints: 0,
      membershipCatalogFraction: 0,
      membershipLevelName: null,
      shipping: ship,
    });

    res.json(
      previewJson(breakdown, {
        audience: 'guest',
        note: 'No membership or points; payableTotalAzn is in AZN for payment/create. Send delivery_country + checkout_currency for zone shipping.',
      })
    );
  } catch (e) {
    const typed = e as Error & { code?: string; payload?: Record<string, unknown> };
    if (typed.code === 'SHIPPING_UNAVAILABLE' && typed.payload && typeof typed.payload === 'object') {
      res.status(400).json(typed.payload);
      return;
    }
    const msg = e instanceof Error ? e.message : 'Guest checkout preview failed';
    res.status(400).json({ error: msg });
  }
}
