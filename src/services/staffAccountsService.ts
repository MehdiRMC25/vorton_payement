import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { config } from '../config';

const SALT_ROUNDS = 10;

export interface StaffAccountEntry {
  email: string;
  password: string;
  role: 'employee' | 'manager';
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20) || 'staff';
}

/** Load and sync staff accounts from config.staffAccountsFile into customers table. Run on startup. */
export async function syncStaffAccounts(): Promise<{ synced: number; errors: string[] }> {
  const filePath = config.staffAccountsFile;
  const pathToRead = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const errors: string[] = [];
  let synced = 0;

  if (!fs.existsSync(pathToRead)) {
    console.warn('Staff accounts file not found (optional):', pathToRead);
    return { synced: 0, errors: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(pathToRead, 'utf-8');
  } catch (e) {
    console.warn('Could not read staff accounts file:', pathToRead, e);
    return { synced: 0, errors: [String(e)] };
  }

  let entries: StaffAccountEntry[];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('Invalid JSON in staff accounts file:', pathToRead, e);
    return { synced: 0, errors: ['Invalid JSON in staff-accounts.json'] };
  }

  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    const email = typeof row?.email === 'string' ? row.email.trim() : '';
    const password = typeof row?.password === 'string' ? row.password : '';
    const role = row?.role === 'manager' ? 'manager' : 'employee';

    if (!email) {
      errors.push(`Entry ${i + 1}: email is required`);
      continue;
    }
    if (!password) {
      errors.push(`Entry ${i + 1}: password is required`);
      continue;
    }

    try {
      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
      const existing = await pool.query(
        'SELECT id FROM customers WHERE email = $1',
        [email]
      );

      if (existing.rows[0]) {
        await pool.query(
          'UPDATE customers SET password_hash = $1, role = $2 WHERE email = $3',
          [password_hash, role, email]
        );
      } else {
        const phone = 'staff-' + slugify(email) + '-' + Date.now().toString(36);
        const membership_number = 'STAFF-' + slugify(email).toUpperCase().slice(0, 8);
        await pool.query(
          `INSERT INTO customers (
            first_name, last_name, email, phone, password_hash, password_salt, membership_number, role
          ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
          ['Staff', role, email, phone, password_hash, membership_number, role]
        );
      }
      synced++;
    } catch (e) {
      errors.push(`Entry ${i + 1} (${email}): ${String(e)}`);
    }
  }

  if (synced > 0) {
    console.log('Staff accounts synced:', synced, 'from', pathToRead);
  }
  if (errors.length > 0) {
    console.warn('Staff accounts sync errors:', errors);
  }
  return { synced, errors };
}
