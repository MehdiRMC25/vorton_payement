import { pool } from '../db';

/** Default levels: min_spent in AZN. 5000 → Gold, 10000 → Platinum. */
const DEFAULT_LEVELS = [
  { name: 'Silver', discount_percent: 5, min_spent: 0 },
  { name: 'Gold', discount_percent: 10, min_spent: 5000 },
  { name: 'Platinum', discount_percent: 15, min_spent: 10000 },
] as const;

/** Get membership level by name (case-insensitive). */
export async function getMembershipLevelByName(name: string): Promise<{ id: number; name: string; discount_percent: number; min_spent: number } | null> {
  const result = await pool.query(
    `SELECT id, name, discount_percent, min_spent FROM membership_levels WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name.trim()]
  );
  return result.rows[0] ?? null;
}

/** Ensure Silver, Gold, Platinum exist in membership_levels; insert if missing, update min_spent if present. */
export async function ensureDefaultMembershipLevels(): Promise<void> {
  for (const level of DEFAULT_LEVELS) {
    const existing = await getMembershipLevelByName(level.name);
    if (!existing) {
      await pool.query(
        `INSERT INTO membership_levels (name, discount_percent, min_spent) VALUES ($1, $2, $3)`,
        [level.name, level.discount_percent, level.min_spent]
      );
    } else {
      await pool.query(
        `UPDATE membership_levels SET discount_percent = $2, min_spent = $3 WHERE id = $1`,
        [existing.id, level.discount_percent, level.min_spent]
      );
    }
  }
}

/** Assign a customer to a membership level (creates row in customer_memberships). */
export async function assignCustomerToLevel(
  customerId: number,
  membershipLevelId: number,
  startDate: Date = new Date(),
  endDate: Date | null = null
): Promise<void> {
  await pool.query(
    `INSERT INTO customer_memberships (customer_id, membership_level_id, start_date, end_date)
     VALUES ($1, $2, $3, $4)`,
    [customerId, membershipLevelId, startDate, endDate]
  );
}

/** Assign Silver (entry level) to a new customer. Call after signup. */
export async function assignSilverToNewCustomer(customerId: number): Promise<void> {
  await ensureDefaultMembershipLevels();
  const silver = await getMembershipLevelByName('Silver');
  if (!silver) {
    throw new Error('Silver membership level not found after ensure');
  }
  await assignCustomerToLevel(customerId, silver.id);
}

/**
 * Total spend for a customer from orders (AZN). Uses orders.total where status is completed/paid.
 * Adjust table/column names if your schema differs (e.g. amount instead of total, different status values).
 */
export async function getCustomerTotalSpend(customerId: number): Promise<number> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(total), 0)::numeric AS total
     FROM orders
     WHERE customer_id = $1 AND status IN ('completed', 'paid', 'delivered', 'Done')`,
    [customerId]
  );
  const val = result.rows[0]?.total;
  return Number(val ?? 0);
}

/**
 * Recalculate and assign the highest membership level the customer qualifies for
 * (Silver 0, Gold 5000 AZN, Platinum 10000 AZN). Call when loading account or after order completion.
 */
export async function recalculateCustomerMembership(customerId: number): Promise<void> {
  await ensureDefaultMembershipLevels();
  const totalSpend = await getCustomerTotalSpend(customerId);
  const levels = await pool.query(
    `SELECT id, name, discount_percent, min_spent FROM membership_levels ORDER BY min_spent DESC`
  );
  const qualifying = levels.rows.find((row: { min_spent: number }) => Number(row.min_spent) <= totalSpend);
  if (!qualifying) return;
  const levelId = qualifying.id;
  const existing = await pool.query(
    `SELECT id FROM customer_memberships WHERE customer_id = $1 ORDER BY start_date DESC LIMIT 1`,
    [customerId]
  );
  if (existing.rows[0] && existing.rows[0].id) {
    const current = await pool.query(
      `SELECT membership_level_id FROM customer_memberships WHERE id = $1`,
      [existing.rows[0].id]
    );
    if (current.rows[0]?.membership_level_id === levelId) return;
  }
  await assignCustomerToLevel(customerId, levelId);
}

/** Get current membership level for a customer (for account page). */
export async function getCustomerMembership(customerId: number): Promise<{ name: string; discount_percent: number; min_spent: number } | null> {
  const result = await pool.query(
    `SELECT ml.name, ml.discount_percent, ml.min_spent
     FROM customer_memberships cm
     JOIN membership_levels ml ON ml.id = cm.membership_level_id
     WHERE cm.customer_id = $1 AND (cm.end_date IS NULL OR cm.end_date >= CURRENT_DATE)
     ORDER BY cm.start_date DESC LIMIT 1`,
    [customerId]
  );
  const row = result.rows[0];
  return row ? { name: row.name, discount_percent: Number(row.discount_percent), min_spent: Number(row.min_spent) } : null;
}
