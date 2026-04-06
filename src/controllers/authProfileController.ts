import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { pool } from '../db';
import {
  getCustomerByIdSafe,
  getCustomerRowById,
  patchCustomerProfile,
  findCustomerIdByPhoneExcluding,
  findCustomerIdByEmailExcluding,
} from '../services/customerService';
import { recalculateCustomerMembership, getCustomerMembership } from '../services/membershipService';
import { sendEmailChangeCode } from '../services/emailService';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

function isValidEmail(email: string): boolean {
  if (!email || email.length > 150) return false;
  return EMAIL_REGEX.test(email.trim());
}

function isValidMobile(phone: string): boolean {
  try {
    return parsePhoneNumberWithError(phone).isValid();
  } catch {
    return false;
  }
}

function normalizePhone(input: string | null): string | null {
  if (!input) return null;
  return input.replace(/\s+/g, '');
}

function pickString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function respondWithUser(_req: Request, res: Response, customerId: number): Promise<void> {
  return (async () => {
    const user = await getCustomerByIdSafe(customerId);
    if (!user) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    let membership = null;
    try {
      await recalculateCustomerMembership(customerId);
      membership = await getCustomerMembership(customerId);
    } catch {
      // optional
    }
    res.json({ user, membership });
  })();
}

/** PATCH /api/v1/auth/profile — Bearer token. Updates address/name/phone; not email (use email flow). */
export async function patchProfile(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const row = await getCustomerRowById(uid);
    if (!row) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const phoneIn = pickString(body, ['phone', 'mobile', 'mobileNumber']);
    const currentPhone = normalizePhone(pickString(body, ['current_phone', 'currentPhone']));
    const password = pickString(body, ['password']);

    const firstName = body.first_name !== undefined ? (typeof body.first_name === 'string' ? body.first_name.trim() : null) : undefined;
    const lastName = body.last_name !== undefined ? (typeof body.last_name === 'string' ? body.last_name.trim() : null) : undefined;
    const address_line1 =
      body.address_line1 !== undefined
        ? typeof body.address_line1 === 'string'
          ? body.address_line1.trim() || null
          : null
        : undefined;
    const address_line2 =
      body.address_line2 !== undefined
        ? typeof body.address_line2 === 'string'
          ? body.address_line2.trim() || null
          : null
        : undefined;
    const city =
      body.city !== undefined ? (typeof body.city === 'string' ? body.city.trim() || null : null) : undefined;
    const postcode =
      body.postcode !== undefined ? (typeof body.postcode === 'string' ? body.postcode.trim() || null : null) : undefined;
    const country =
      body.country !== undefined ? (typeof body.country === 'string' ? body.country.trim() || null : null) : undefined;

    if (body.email !== undefined && pickString(body, ['email'])) {
      res.status(400).json({ error: 'Use the email verification flow to change email.' });
      return;
    }

    if (phoneIn !== null) {
      const normalizedNew = normalizePhone(phoneIn);
      if (!normalizedNew || !isValidMobile(normalizedNew)) {
        res.status(400).json({ error: 'Invalid mobile number' });
        return;
      }
      const existingNorm = normalizePhone(row.phone as string | null);
      if (existingNorm && normalizedNew === existingNorm) {
        res.status(400).json({ error: 'New number matches current number.' });
        return;
      }
      const other = await findCustomerIdByPhoneExcluding(normalizedNew, uid);
      if (other) {
        res.status(409).json({ error: 'This mobile number is already registered.' });
        return;
      }
      if (existingNorm) {
        if (!currentPhone || normalizePhone(currentPhone) !== existingNorm) {
          res.status(400).json({ error: 'Enter your current mobile number to confirm the change.' });
          return;
        }
      }
      if (password) {
        let match = false;
        try {
          match = row.password_hash ? await bcrypt.compare(password, row.password_hash) : false;
        } catch {
          match = false;
        }
        if (!match) {
          res.status(401).json({ error: 'Invalid password' });
          return;
        }
      }
      await patchCustomerProfile(uid, {
        first_name: firstName,
        last_name: lastName,
        address_line1,
        address_line2,
        city,
        postcode,
        country,
        phone: normalizedNew,
      });
      await respondWithUser(req, res, uid);
      return;
    }

    await patchCustomerProfile(uid, {
      first_name: firstName,
      last_name: lastName,
      address_line1,
      address_line2,
      city,
      postcode,
      country,
    });
    await respondWithUser(req, res, uid);
  } catch (err) {
    console.error('patchProfile:', err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
}

const CODE_TTL_MIN = 15;
const SALT_ROUNDS = 10;

/** POST /api/v1/auth/profile/email/request-code */
export async function requestEmailChangeCode(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const newEmail = pickString(body, ['new_email', 'newEmail', 'email']) ?? '';
    if (!isValidEmail(newEmail)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    const row = await getCustomerRowById(uid);
    if (!row) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const currentEmail = (row.email as string | null)?.trim().toLowerCase() ?? '';
    if (newEmail.trim().toLowerCase() === currentEmail) {
      res.status(400).json({ error: 'New email must differ from current email.' });
      return;
    }
    const taken = await findCustomerIdByEmailExcluding(newEmail, uid);
    if (taken) {
      res.status(409).json({ error: 'This email is already registered.' });
      return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const code_hash = await bcrypt.hash(code, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000);

    await pool.query(
      `DELETE FROM email_change_pending WHERE customer_id = $1`,
      [uid]
    );
    await pool.query(
      `INSERT INTO email_change_pending (customer_id, new_email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [uid, newEmail.trim().toLowerCase(), code_hash, expiresAt]
    );

    const sent = await sendEmailChangeCode(newEmail.trim(), code);
    if (!sent) {
      await pool.query(`DELETE FROM email_change_pending WHERE customer_id = $1`, [uid]);
      res.status(503).json({ error: 'Email is not configured on the server. Cannot send verification code.' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('requestEmailChangeCode:', err);
    res.status(500).json({ error: 'Could not send verification code.' });
  }
}

/** POST /api/v1/auth/profile/email/confirm */
export async function confirmEmailChange(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const newEmail = pickString(body, ['new_email', 'newEmail', 'email']) ?? '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!isValidEmail(newEmail) || !code) {
      res.status(400).json({ error: 'Invalid email or code.' });
      return;
    }

    const result = await pool.query(
      `SELECT id, new_email, code_hash, expires_at FROM email_change_pending WHERE customer_id = $1`,
      [uid]
    );
    const pending = result.rows[0];
    if (!pending) {
      res.status(400).json({ error: 'No pending email change. Request a new code.' });
      return;
    }
    if (pending.new_email !== newEmail.trim().toLowerCase()) {
      res.status(400).json({ error: 'Email does not match pending change.' });
      return;
    }
    if (new Date(pending.expires_at) < new Date()) {
      await pool.query(`DELETE FROM email_change_pending WHERE customer_id = $1`, [uid]);
      res.status(400).json({ error: 'Code expired. Request a new code.' });
      return;
    }
    const ok = await bcrypt.compare(code, pending.code_hash);
    if (!ok) {
      res.status(400).json({ error: 'Invalid verification code.' });
      return;
    }

    const taken = await findCustomerIdByEmailExcluding(newEmail, uid);
    if (taken) {
      res.status(409).json({ error: 'This email is already registered.' });
      return;
    }

    await pool.query(`UPDATE customers SET email = $1 WHERE id = $2`, [newEmail.trim().toLowerCase(), uid]);
    await pool.query(`DELETE FROM email_change_pending WHERE customer_id = $1`, [uid]);

    const user = await getCustomerByIdSafe(uid);
    res.json({ user, data: { user } });
  } catch (err) {
    console.error('confirmEmailChange:', err);
    res.status(500).json({ error: 'Could not confirm email change.' });
  }
}

/** POST /api/v1/auth/checkout-delivery — append-only delivery contact for this checkout (does not replace profile). */
export async function appendCheckoutDelivery(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : '';
    const addressRaw = typeof body.address === 'string' ? body.address.trim() : '';
    if (!phoneRaw && !addressRaw) {
      res.status(400).json({ error: 'Provide a mobile number and/or address.' });
      return;
    }
    if (phoneRaw && !isValidMobile(phoneRaw)) {
      res.status(400).json({ error: 'Invalid mobile number' });
      return;
    }

    const insert = await pool.query(
      `INSERT INTO customer_delivery_contact_log (customer_id, phone, address_text, source)
       VALUES ($1, $2, $3, 'checkout')
       RETURNING id`,
      [uid, phoneRaw || null, addressRaw || null]
    );
    const rowId = insert.rows[0]?.id as number | undefined;

    res.status(201).json({ ok: true, id: rowId });
  } catch (err) {
    console.error('appendCheckoutDelivery:', err);
    res.status(500).json({ error: 'Could not save delivery details.' });
  }
}
