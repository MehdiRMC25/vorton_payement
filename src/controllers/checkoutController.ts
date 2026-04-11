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
      pointsRedeemed: breakdown.pointsRedeemed,
      pointsDiscountAzn: breakdown.pointsDiscountAzn,
      payableTotalAzn: breakdown.payableTotalAzn,
      membershipLevelName: breakdown.membershipLevelName,
      membershipCatalogFraction: breakdown.membershipCatalogFraction,
    },
  };
}

/** POST /api/v1/checkout/preview — Bearer JWT. Same totals logic as payment create (for UI parity). */
export async function previewCheckout(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as { items?: unknown; points_to_redeem?: unknown };
    const items = Array.isArray(body.items) ? (body.items as OrderItem[]) : [];
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
    });

    res.json(previewJson(breakdown, { audience: 'member' }));
  } catch (e) {
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
    const body = req.body as { items?: unknown; points_to_redeem?: unknown };
    const items = Array.isArray(body.items) ? (body.items as OrderItem[]) : [];
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
    });

    res.json(
      previewJson(breakdown, {
        audience: 'guest',
        note: 'No membership or points; payableTotalAzn is in AZN for payment/create.',
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Guest checkout preview failed';
    res.status(400).json({ error: msg });
  }
}
