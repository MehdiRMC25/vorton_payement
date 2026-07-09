import { pool } from '../db';

export interface CreateCustomerData {
  first_name: string;
  last_name: string;
  email: string | null;
  second_email?: string | null;
  third_email?: string | null;
  phone: string;
  second_phone?: string | null;
  third_phone?: string | null;
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
      first_name, last_name, email, second_email, third_email,
      phone, second_phone, third_phone,
      password_hash, password_salt, membership_number,
      address_line1, address_line2, city, postcode, country
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id`,
    [
      data.first_name,
      data.last_name,
      data.email ?? null,
      data.second_email ?? null,
      data.third_email ?? null,
      data.phone,
      data.second_phone ?? null,
      data.third_phone ?? null,
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
  const id = identifier.trim();
  const result = await pool.query(
    `SELECT * FROM customers
     WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
        OR LOWER(TRIM(second_email)) = LOWER(TRIM($1))
        OR LOWER(TRIM(third_email)) = LOWER(TRIM($1))
        OR phone = $2
        OR second_phone = $2
        OR third_phone = $2`,
    [id, id]
  );

  /** Find customer by primary, second, or third email (case-insensitive). */
  export async function getCustomerByAnyEmail(email: string) {
    const result = await pool.query(
        `SELECT * FROM customers
     WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
        OR LOWER(TRIM(second_email)) = LOWER(TRIM($1))
        OR LOWER(TRIM(third_email)) = LOWER(TRIM($1))
     LIMIT 1`,
        [email.trim()]
    );
    return result.rows[0];
  }

  export async function updateCustomerPassword(
      customerId: number,
      passwordHash: string,
      passwordSalt: string | null
  ): Promise<void> {
    await pool.query(`UPDATE customers SET password_hash = $1, password_salt = $2 WHERE id = $3`, [
      passwordHash,
      passwordSalt,
      customerId,
    ]);
  }


  return result.rows[0];
}

/** Use for API responses. Excludes password_hash and password_salt. Includes role for access control. */
export async function getCustomerByIdSafe(id: number) {
  const result = await pool.query(
    `SELECT id, first_name, last_name, email, second_email, third_email,
            phone, second_phone, third_phone,
            membership_number,
            address_line1, address_line2, city, postcode, country, created_at,
            COALESCE(role, 'customer') AS role,
            COALESCE(reward_points_balance, 0)::int AS reward_points_balance,
            COALESCE(reward_points_balance, 0)::int AS loyalty_credits,
            COALESCE(email_verified, FALSE) AS email_verified,
            COALESCE(second_email_verified, FALSE) AS second_email_verified,
            COALESCE(third_email_verified, FALSE) AS third_email_verified,
            COALESCE(account_status, 'active') AS account_status,
            deletion_requested_at,
            scheduled_deletion_at,
            deletion_reason
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
    `SELECT id FROM customers
     WHERE id <> $2
       AND ($1 IN (phone, second_phone, third_phone))
     LIMIT 1`,
    [phone, excludeId]
  );
  return result.rows[0]?.id ?? null;
}

/** Find another customer using this email (excluding id). */
export async function findCustomerIdByEmailExcluding(email: string, excludeId: number): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM customers
     WHERE id <> $2
       AND (
         LOWER(TRIM(email)) = LOWER(TRIM($1))
         OR LOWER(TRIM(second_email)) = LOWER(TRIM($1))
         OR LOWER(TRIM(third_email)) = LOWER(TRIM($1))
       )
     LIMIT 1`,
    [email, excludeId]
  );
  return result.rows[0]?.id ?? null;
}

export type CustomerProfilePatch = {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
  phone?: string;
  second_phone?: string | null;
  third_phone?: string | null;
  second_email?: string | null;
  third_email?: string | null;
};

/** Updates only keys that are present (not undefined). Null clears optional text fields. */
export async function patchCustomerProfile(id: number, patch: CustomerProfilePatch): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const allowed = new Set([
    'first_name',
    'last_name',
    'email',
    'address_line1',
    'address_line2',
    'city',
    'postcode',
    'country',
    'phone',
    'second_phone',
    'third_phone',
    'second_email',
    'third_email',
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

export async function requestCustomerDeletion(
    customerId: number,
    deletionReason: string | null,
    graceDays: number
): Promise<{ scheduled_deletion_at: string } | null> {
  const result = await pool.query(
      `UPDATE customers
     SET account_status = 'pending_deletion',
         deletion_requested_at = NOW(),
         scheduled_deletion_at = NOW() + ($2::int * INTERVAL '1 day'),
         deletion_reason = $3
     WHERE id = $1
       AND COALESCE(account_status, 'active') = 'active'
     RETURNING scheduled_deletion_at`,
      [customerId, graceDays, deletionReason]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { scheduled_deletion_at: String(row.scheduled_deletion_at) };
}

export async function cancelCustomerDeletion(customerId: number): Promise<boolean> {
  const result = await pool.query(
      `UPDATE customers
     SET account_status = 'active',
         deletion_requested_at = NULL,
         scheduled_deletion_at = NULL,
         deletion_reason = NULL
     WHERE id = $1
       AND account_status = 'pending_deletion'`,
      [customerId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function archiveAndDeleteCustomer(customerId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const locked = await client.query(
        `SELECT id, deletion_reason
       FROM customers
       WHERE id = $1
         AND account_status = 'pending_deletion'
       FOR UPDATE`,
        [customerId]
    );
    if (!locked.rows[0]) {
      await client.query('ROLLBACK');
      return;
    }

    const reason = locked.rows[0].deletion_reason ?? null;

    await client.query(
        `INSERT INTO customers_deleted_archive
       SELECT c.*, NOW(), $2::text
       FROM customers c
       WHERE c.id = $1`,
        [customerId, reason]
    );

    await client.query('DELETE FROM cart_items WHERE user_id = $1', [customerId]);
    await client.query('UPDATE orders SET customer_id = NULL WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customers WHERE id = $1', [customerId]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function finalizeDueAccountDeletions(): Promise<number> {
  const due = await pool.query(
      `SELECT id
     FROM customers
     WHERE account_status = 'pending_deletion'
       AND scheduled_deletion_at IS NOT NULL
       AND scheduled_deletion_at <= NOW()`
  );
  let count = 0;
  for (const row of due.rows) {
    await archiveAndDeleteCustomer(Number(row.id));
    count += 1;
  }
  return count;
}