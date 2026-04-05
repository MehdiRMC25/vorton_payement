import { pool } from '../db';

export interface CreateCustomerData {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string;
  second_phone?: string | null;
  password_hash: string;
  password_salt: string | null;
  membership_number: string;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
}

export async function createCustomer(data: CreateCustomerData) {
  const result = await pool.query(
    `INSERT INTO customers (
      first_name, last_name, email, phone, second_phone,
      password_hash, password_salt, membership_number,
      address_line1, address_line2, city, postcode, country
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id`,
    [
      data.first_name,
      data.last_name,
      data.email ?? null,
      data.phone,
      data.second_phone ?? null,
      data.password_hash,
      data.password_salt ?? null,
      data.membership_number,
      data.address_line1 ?? null,
      data.address_line2 ?? null,
      data.city ?? null,
      data.postcode ?? null,
      data.country ?? null,
    ]
  );
  return result.rows[0];
}

/** Use only server-side (e.g. login). Returns full row including password_hash. */
export async function getCustomerByEmail(email: string) {
  const result = await pool.query(
    `SELECT * FROM customers WHERE email = $1`,
    [email]
  );
  return result.rows[0];
}

/** Find by email or phone. Use only server-side (e.g. login). */
export async function getCustomerByEmailOrPhone(identifier: string) {
  const result = await pool.query(
    `SELECT * FROM customers WHERE email = $1 OR phone = $1`,
    [identifier.trim()]
  );
  return result.rows[0];
}

/** Use for API responses. Excludes password_hash and password_salt. Includes role for access control. */
export async function getCustomerByIdSafe(id: number) {
  const result = await pool.query(
    `SELECT id, first_name, last_name, email, phone, second_phone, membership_number,
            address_line1, address_line2, city, postcode, country, created_at,
            COALESCE(role, 'customer') AS role,
            COALESCE(reward_points_balance, 0)::int AS reward_points_balance
     FROM customers WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

/** Full row including password_hash — server-side only. */
export async function getCustomerRowById(id: number) {
  const result = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
  return result.rows[0];
}

/** Find another customer using this phone (excluding id). */
export async function findCustomerIdByPhoneExcluding(phone: string, excludeId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM customers WHERE phone = $1 AND id <> $2 LIMIT 1`,
    [phone, excludeId]
  );
  return result.rows[0]?.id ?? null;
}

/** Find another customer using this email (excluding id). */
export async function findCustomerIdByEmailExcluding(email: string, excludeId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND id <> $2 LIMIT 1`,
    [email, excludeId]
  );
  return result.rows[0]?.id ?? null;
}

export type CustomerProfilePatch = {
  first_name?: string | null;
  last_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
  phone?: string;
};

/** Updates only keys that are present (not undefined). Null clears optional text fields. */
export async function patchCustomerProfile(id: number, patch: CustomerProfilePatch): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const allowed = new Set([
    'first_name',
    'last_name',
    'address_line1',
    'address_line2',
    'city',
    'postcode',
    'country',
    'phone',
  ]);
  const cols = entries.filter(([k]) => allowed.has(k));
  if (cols.length === 0) return;
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, val] of cols) {
    sets.push(`${key} = $${i}`);
    values.push(val);
    i += 1;
  }
  values.push(id);
  await pool.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${i}`, values);
}
