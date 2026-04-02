/**
 * Reward points policy — pure calculation (see docs/reward-points-policy.md).
 * Eligible subtotal excludes discounted/promotional lines (flagged on order items).
 */

export const POINTS_PER_AZN = 11;

/** Max share of an order that may be paid with points (policy upper bound; redemption TBD). */
export const REDEMPTION_MAX_PERCENT_HIGH = 50;
export const REDEMPTION_MAX_PERCENT_LOW = 30;

/** Default points expiry from earn date (months). */
export const POINTS_EXPIRY_MONTHS = 12;

export type LineForPoints = {
  quantity: number;
  price: number;
  /** When true, this line does not count toward eligible subtotal. */
  is_discounted?: boolean;
  promotional?: boolean;
};

export function tierPercentForEligibleSubtotal(eligibleAzn: number): number {
  if (eligibleAzn <= 0) return 0;
  if (eligibleAzn < 120) return 3;
  if (eligibleAzn < 300) return 5;
  return 7;
}

export function lineCountsTowardPoints(line: LineForPoints): boolean {
  if (line.is_discounted === true) return false;
  if (line.promotional === true) return false;
  return true;
}

export function computeEligibleSubtotalAzn(items: LineForPoints[]): number {
  let sum = 0;
  for (const it of items) {
    if (!lineCountsTowardPoints(it)) continue;
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    sum += qty * price;
  }
  return Math.round(sum * 100) / 100;
}

export function rewardAznFromEligible(eligibleAzn: number): number {
  const pct = tierPercentForEligibleSubtotal(eligibleAzn);
  if (pct <= 0 || eligibleAzn <= 0) return 0;
  return Math.round((eligibleAzn * (pct / 100)) * 100) / 100;
}

export function pointsFromRewardAzn(rewardAzn: number): number {
  if (rewardAzn <= 0) return 0;
  return Math.round(rewardAzn * POINTS_PER_AZN);
}

export function calculatePointsForOrder(items: LineForPoints[]): {
  eligibleSubtotalAzn: number;
  tierPercent: number;
  rewardAzn: number;
  points: number;
} {
  const eligibleSubtotalAzn = computeEligibleSubtotalAzn(items);
  const tierPercent = tierPercentForEligibleSubtotal(eligibleSubtotalAzn);
  const rewardAzn = rewardAznFromEligible(eligibleSubtotalAzn);
  const points = pointsFromRewardAzn(rewardAzn);
  return { eligibleSubtotalAzn, tierPercent, rewardAzn, points };
}

/** Sum of line totals (qty × price); not the same as reward-eligible subtotal. */
export function merchandiseGrossAznFromItems(
  items: Array<{ quantity: unknown; price: unknown }>
): number {
  let sum = 0;
  for (const it of items || []) {
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    sum += qty * price;
  }
  return Math.round(sum * 100) / 100;
}

/** AZN value when redeeming points at the same rate as earning (1 AZN = 11 points). */
export function discountAznFromRedeemPoints(points: number): number {
  if (points <= 0) return 0;
  return Math.round((points / POINTS_PER_AZN) * 100) / 100;
}

/** Max whole points that can be redeemed: balance cap and % of merchandise gross cap. */
export function maxRedeemablePoints(grossMerchandiseAzn: number, balancePoints: number): number {
  if (grossMerchandiseAzn <= 0 || balancePoints <= 0) return 0;
  const maxDisc = Math.round(grossMerchandiseAzn * (REDEMPTION_MAX_PERCENT_HIGH / 100) * 100) / 100;
  const cap = Math.min(maxDisc, grossMerchandiseAzn);
  let p = Math.min(balancePoints, Math.ceil(cap * POINTS_PER_AZN));
  while (p > 0 && discountAznFromRedeemPoints(p) > cap + 0.001) p -= 1;
  while (p > 0 && discountAznFromRedeemPoints(p) > grossMerchandiseAzn + 0.001) p -= 1;
  return p;
}

export function validateRedemptionRequest(
  pointsRequested: number,
  grossMerchandiseAzn: number,
  balancePoints: number
): { ok: true; points: number; discountAzn: number } | { ok: false; error: string } {
  const p = Math.floor(pointsRequested);
  if (p <= 0) return { ok: false, error: 'points_to_redeem must be a positive integer' };
  if (p > balancePoints) return { ok: false, error: 'Insufficient reward points balance' };
  const maxP = maxRedeemablePoints(grossMerchandiseAzn, balancePoints);
  if (p > maxP) return { ok: false, error: 'points_to_redeem exceeds maximum allowed for this order' };
  const discountAzn = discountAznFromRedeemPoints(p);
  if (discountAzn > grossMerchandiseAzn + 0.001) {
    return { ok: false, error: 'Points discount cannot exceed order merchandise total' };
  }
  return { ok: true, points: p, discountAzn };
}
