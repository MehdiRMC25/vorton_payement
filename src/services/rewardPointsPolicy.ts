/**
 * Reward points policy — pure calculation (see docs/reward-points-policy.md).
 * Eligible subtotal excludes discounted/promotional lines (flagged on order items).
 */

/** Conversion: 1 USD reward value = 11 points. */
export const POINTS_PER_USD = 11;

/** Default FX: 1 USD = 1.7 AZN (override via env). */
export const DEFAULT_AZN_PER_USD = 1.7;

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

function aznPerUsd(): number {
  const raw = (process.env.REWARD_AZN_PER_USD ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_AZN_PER_USD;
}

function usdFromAzn(azn: number): number {
  const fx = aznPerUsd();
  if (!Number.isFinite(fx) || fx <= 0) return azn / DEFAULT_AZN_PER_USD;
  return azn / fx;
}

function aznFromUsd(usd: number): number {
  return usd * aznPerUsd();
}

/** Earning tiers are based on eligible subtotal in USD. Returns percent back (2 / 3.5 / 5). */
export function tierPercentForEligibleSubtotalUsd(eligibleUsd: number): number {
  if (eligibleUsd <= 0) return 0;
  if (eligibleUsd < 72) return 2;
  if (eligibleUsd < 180) return 3.5;
  return 5;
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

export function rewardUsdFromEligibleUsd(eligibleUsd: number): number {
  const pct = tierPercentForEligibleSubtotalUsd(eligibleUsd);
  if (pct <= 0 || eligibleUsd <= 0) return 0;
  // Reward value in USD
  return Math.round((eligibleUsd * (pct / 100)) * 100) / 100;
}

export function pointsFromRewardUsd(rewardUsd: number): number {
  if (rewardUsd <= 0) return 0;
  // Policy: points rounded down to nearest whole point (not banker's rounding).
  return Math.max(0, Math.floor(rewardUsd * POINTS_PER_USD + 1e-9));
}

export function calculatePointsForOrder(items: LineForPoints[]): {
  eligibleSubtotalAzn: number;
  tierPercent: number;
  rewardAzn: number;
  points: number;
} {
  const eligibleSubtotalAzn = computeEligibleSubtotalAzn(items);
  const eligibleUsd = usdFromAzn(eligibleSubtotalAzn);
  const tierPercent = tierPercentForEligibleSubtotalUsd(eligibleUsd);
  const rewardUsd = rewardUsdFromEligibleUsd(eligibleUsd);
  const rewardAzn = Math.round(aznFromUsd(rewardUsd) * 100) / 100;
  const points = pointsFromRewardUsd(rewardUsd);
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

/** AZN discount value when redeeming points (11 points = 1 USD, converted to AZN by FX). */
export function discountAznFromRedeemPoints(points: number): number {
  if (points <= 0) return 0;
  const usd = points / POINTS_PER_USD;
  return Math.round(aznFromUsd(usd) * 100) / 100;
}

/** Max whole points that can be redeemed: balance cap and % of merchandise gross cap. */
export function maxRedeemablePoints(eligibleSubtotalAzn: number, balancePoints: number): number {
  if (eligibleSubtotalAzn <= 0 || balancePoints <= 0) return 0;
  // Policy: points can only be redeemed against eligible (non-discounted, non-service) items.
  const maxDisc = Math.round(eligibleSubtotalAzn * (REDEMPTION_MAX_PERCENT_HIGH / 100) * 100) / 100;
  const cap = Math.min(maxDisc, eligibleSubtotalAzn);
  const capUsd = usdFromAzn(cap);
  let p = Math.min(balancePoints, Math.ceil(capUsd * POINTS_PER_USD));
  while (p > 0 && discountAznFromRedeemPoints(p) > cap + 0.001) p -= 1;
  while (p > 0 && discountAznFromRedeemPoints(p) > eligibleSubtotalAzn + 0.001) p -= 1;
  return p;
}

export function validateRedemptionRequest(
  pointsRequested: number,
  eligibleSubtotalAzn: number,
  balancePoints: number
): { ok: true; points: number; discountAzn: number } | { ok: false; error: string } {
  const p = Math.floor(pointsRequested);
  if (p <= 0) return { ok: false, error: 'points_to_redeem must be a positive integer' };
  if (p > balancePoints) return { ok: false, error: 'Insufficient reward points balance' };
  const maxP = maxRedeemablePoints(eligibleSubtotalAzn, balancePoints);
  if (p > maxP) return { ok: false, error: 'points_to_redeem exceeds maximum allowed for this order' };
  const discountAzn = discountAznFromRedeemPoints(p);
  if (discountAzn > eligibleSubtotalAzn + 0.001) {
    return { ok: false, error: 'Points discount cannot exceed eligible merchandise total' };
  }
  return { ok: true, points: p, discountAzn };
}
