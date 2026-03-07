import { pool } from '../db';

/** Default levels per your policy. min_spent = minimum spend to qualify (0 = entry). */
const DEFAULT_LEVELS = [
  { name: 'Silver', discount_percent: 5, min_spent: 0 },
  { name: 'Gold', discount_percent: 10, min_spent: 0 },
  { name: 'Platinum', discount_percent: 15, min_spent: 0 },
] as const;

/** Get membership level by name (case-insensitive). */
export async function getMembershipLevelByName(name: string): Promise<{ id: number; name: string; discount_percent: number; min_spent: number } | null> {
  const result = await pool.query(
    `SELECT id, name, discount_percent, min_spent FROM membership_levels WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name.trim()]
  );
  return result.rows[0] ?? null;
}

/** Ensure Silver, Gold, Platinum exist in membership_levels; insert if missing. */
export async function ensureDefaultMembershipLevels(): Promise<void> {
  for (const level of DEFAULT_LEVELS) {
    const existing = await getMembershipLevelByName(level.name);
    if (!existing) {
      await pool.query(
        `INSERT INTO membership_levels (name, discount_percent, min_spent) VALUES ($1, $2, $3)`,
        [level.name, level.discount_percent, level.min_spent]
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
