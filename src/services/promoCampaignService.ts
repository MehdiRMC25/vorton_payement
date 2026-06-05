import { pool } from '../db';

export type PromoCodeRow = {
  id: number;
  code: string;
  label: string;
  is_active: boolean;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
};

export async function loadPromoCodeByCode(code: string): Promise<PromoCodeRow | null> {
  const c = code.trim().toUpperCase();
  if (!c) return null;
  const res = await pool.query<PromoCodeRow>(
      `SELECT id, code, label, is_active, starts_at, ends_at
     FROM promo_codes
     WHERE UPPER(code) = $1
     LIMIT 1`,
      [c]
  );
  return res.rows[0] ?? null;
}

/** Same is_active / starts_at / ends_at rules as checkoutTotalsService (no cart/eligibility). */
export function isPromoCodeInCampaignWindow(row: PromoCodeRow): boolean {
  if (row.is_active !== true) return false;
  const now = new Date();
  if (row.starts_at && now < new Date(String(row.starts_at))) return false;
  if (row.ends_at && now > new Date(String(row.ends_at))) return false;
  return true;
}