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

/** Strict ASCII-only email: local@domain.tld (no spaces / no Unicode). */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function isValidAsciiEmail(email: string): boolean {
  if (!email || email.length > 150) return false;
  if (/[^\x00-\x7F]/.test(email)) return false;
  return EMAIL_RE.test(email.trim());
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

function normalizeEmail(input: string | null): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return e || null;
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

type OptionalField<T> = { present: boolean; value: T };

function pickNullableStringField(body: Record<string, unknown>, keys: string[]): OptionalField<string | null> {
  for (const key of keys) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) return { present: true, value: null };
    if (typeof v === 'string') {
      const t = v.trim();
      return { present: true, value: t ? t : null };
    }
    // If explicitly present but not a string/null, treat as invalid by returning present with null-ish sentinel.
    return { present: true, value: '__INVALID__' as unknown as string };
  }
  return { present: false, value: null };
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

    // Debug aid: log which keys arrived (avoid printing PII values).
    // Enable by setting PROFILE_PATCH_DEBUG=1 in env.
    if (process.env.PROFILE_PATCH_DEBUG === '1') {
      const keys = body && typeof body === 'object' ? Object.keys(body).slice(0, 50) : [];
      console.log('[ProfilePatch] keys:', keys);
      console.log('[ProfilePatch] has second_email:', Object.prototype.hasOwnProperty.call(body, 'second_email') || Object.prototype.hasOwnProperty.call(body, 'secondEmail'));
      console.log('[ProfilePatch] has address_line2:', Object.prototype.hasOwnProperty.call(body, 'address_line2'));
    }
    const row = await getCustomerRowById(uid);
    if (!row) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const phoneIn = pickString(body, ['phone', 'mobile', 'mobileNumber']);
    const currentPhone = normalizePhone(pickString(body, ['current_phone', 'currentPhone']));
    const password = pickString(body, ['password']);

    const emailField = pickNullableStringField(body, ['email']);
    const secondPhoneField = pickNullableStringField(body, ['second_phone', 'secondPhone', 'second_mobile', 'mobile_secondary']);
    const thirdPhoneField = pickNullableStringField(body, ['third_phone', 'thirdPhone', 'third_mobile', 'mobile_tertiary']);
    const secondEmailField = pickNullableStringField(body, ['second_email', 'secondEmail', 'email_secondary']);
    const thirdEmailField = pickNullableStringField(body, ['third_email', 'thirdEmail', 'email_tertiary']);

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

    // Validate email + secondary/tertiary email + phone types if they were explicitly provided.
    if (emailField.present && (emailField.value as unknown) === '__INVALID__') {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    if (secondPhoneField.present && (secondPhoneField.value as unknown) === '__INVALID__') {
      res.status(400).json({ error: 'Invalid mobile number' });
      return;
    }
    if (thirdPhoneField.present && (thirdPhoneField.value as unknown) === '__INVALID__') {
      res.status(400).json({ error: 'Invalid mobile number' });
      return;
    }
    if (secondEmailField.present && (secondEmailField.value as unknown) === '__INVALID__') {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    if (thirdEmailField.present && (thirdEmailField.value as unknown) === '__INVALID__') {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    const emailNorm = emailField.present ? normalizeEmail(emailField.value) : undefined;
    const secondPhoneNorm = secondPhoneField.present ? normalizePhone(secondPhoneField.value) : undefined;
    const thirdPhoneNorm = thirdPhoneField.present ? normalizePhone(thirdPhoneField.value) : undefined;
    const secondEmailNorm = secondEmailField.present ? normalizeEmail(secondEmailField.value) : undefined;
    const thirdEmailNorm = thirdEmailField.present ? normalizeEmail(thirdEmailField.value) : undefined;
    const emailChanged =
        emailField.present && emailNorm !== ((row.email as string | null) ?? '').trim().toLowerCase();
    const secondEmailChanged =
        secondEmailField.present && secondEmailNorm !== ((row.second_email as string | null) ?? '').trim().toLowerCase();
    const thirdEmailChanged =
        thirdEmailField.present && thirdEmailNorm !== ((row.third_email as string | null) ?? '').trim().toLowerCase();

    if (secondPhoneField.present && secondPhoneNorm && !isValidMobile(secondPhoneNorm)) {
      res.status(400).json({ error: 'Invalid mobile number' });
      return;
    }
    if (thirdPhoneField.present && thirdPhoneNorm && !isValidMobile(thirdPhoneNorm)) {
      res.status(400).json({ error: 'Invalid mobile number' });
      return;
    }
    if (emailField.present && emailNorm && !isValidAsciiEmail(emailNorm)) {
      res.status(400).json({ error: 'Invalid email address (ASCII only).' });
      return;
    }
    if (secondEmailField.present && secondEmailNorm && !isValidAsciiEmail(secondEmailNorm)) {
      res.status(400).json({ error: 'Invalid email address (ASCII only).' });
      return;
    }
    if (thirdEmailField.present && thirdEmailNorm && !isValidAsciiEmail(thirdEmailNorm)) {
      res.status(400).json({ error: 'Invalid email address (ASCII only).' });
      return;
    }

    // Prevent duplicates within the same customer (across all email slots and phone slots).
    const currentEmail = ((row.email as string | null) ?? '').trim().toLowerCase();
    const currentSecondEmail = ((row.second_email as string | null) ?? '').trim().toLowerCase();
    const currentThirdEmail = ((row.third_email as string | null) ?? '').trim().toLowerCase();

    const emailCandidates = [
      emailField.present ? (emailNorm ?? null) : (currentEmail || null),
      secondEmailField.present ? (secondEmailNorm ?? null) : (currentSecondEmail || null),
      thirdEmailField.present ? (thirdEmailNorm ?? null) : (currentThirdEmail || null),
    ].filter((x): x is string => !!x);
    if (new Set(emailCandidates.map(e => e.trim().toLowerCase())).size !== emailCandidates.length) {
      res.status(400).json({ error: 'Email addresses must be different.' });
      return;
    }

    const currentPhoneNorm = normalizePhone((row.phone as string | null) ?? '') ?? '';
    const currentSecondPhoneNorm = normalizePhone((row.second_phone as string | null) ?? '') ?? '';
    const currentThirdPhoneNorm = normalizePhone((row.third_phone as string | null) ?? '') ?? '';

    const phoneCandidates = [
      currentPhoneNorm || null,
      secondPhoneField.present ? (secondPhoneNorm ?? null) : (currentSecondPhoneNorm || null),
      thirdPhoneField.present ? (thirdPhoneNorm ?? null) : (currentThirdPhoneNorm || null),
    ].filter((x): x is string => !!x);
    if (new Set(phoneCandidates.map(p => p.replace(/\s+/g, ''))).size !== phoneCandidates.length) {
      res.status(400).json({ error: 'Mobile numbers must be different.' });
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

      // If secondary/tertiary values are being updated in the same request, enforce global uniqueness too.
      if (emailField.present && emailNorm) {
        const otherE1 = await findCustomerIdByEmailExcluding(emailNorm, uid);
        if (otherE1) {
          res.status(409).json({ error: 'This email is already registered.' });
          return;
        }
      }
      if (secondPhoneField.present && secondPhoneNorm) {
        const other2 = await findCustomerIdByPhoneExcluding(secondPhoneNorm, uid);
        if (other2) {
          res.status(409).json({ error: 'This mobile number is already registered.' });
          return;
        }
      }
      if (thirdPhoneField.present && thirdPhoneNorm) {
        const other3 = await findCustomerIdByPhoneExcluding(thirdPhoneNorm, uid);
        if (other3) {
          res.status(409).json({ error: 'This mobile number is already registered.' });
          return;
        }
      }
      if (secondEmailField.present && secondEmailNorm) {
        const otherE2 = await findCustomerIdByEmailExcluding(secondEmailNorm, uid);
        if (otherE2) {
          res.status(409).json({ error: 'This email is already registered.' });
          return;
        }
      }
      if (thirdEmailField.present && thirdEmailNorm) {
        const otherE3 = await findCustomerIdByEmailExcluding(thirdEmailNorm, uid);
        if (otherE3) {
          res.status(409).json({ error: 'This email is already registered.' });
          return;
        }
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
        email: emailNorm,
        second_phone: secondPhoneNorm,
        third_phone: thirdPhoneNorm,
        second_email: secondEmailNorm,
        third_email: thirdEmailNorm,
      });
      if (emailChanged || secondEmailChanged || thirdEmailChanged) {
        const flags: string[] = [];
        if (emailChanged) flags.push('email_verified = FALSE');
        if (secondEmailChanged) flags.push('second_email_verified = FALSE');
        if (thirdEmailChanged) flags.push('third_email_verified = FALSE');

        if (flags.length > 0) {
          await pool.query(`UPDATE customers SET ${flags.join(', ')} WHERE id = $1`, [uid]);
        }
      }
      await respondWithUser(req, res, uid);
      return;
    }

     // Uniqueness across customers for secondary/tertiary fields when provided.
    if (emailField.present && emailNorm) {
      const other = await findCustomerIdByEmailExcluding(emailNorm, uid);
      if (other) {
        res.status(409).json({ error: 'This email is already registered.' });
        return;
      }
    }
    if (secondPhoneField.present && secondPhoneNorm) {
      const other = await findCustomerIdByPhoneExcluding(secondPhoneNorm, uid);
      if (other) {
        res.status(409).json({ error: 'This mobile number is already registered.' });
        return;
      }
    }
    if (thirdPhoneField.present && thirdPhoneNorm) {
      const other = await findCustomerIdByPhoneExcluding(thirdPhoneNorm, uid);
      if (other) {
        res.status(409).json({ error: 'This mobile number is already registered.' });
        return;
      }
    }
    if (secondEmailField.present && secondEmailNorm) {
      const other = await findCustomerIdByEmailExcluding(secondEmailNorm, uid);
      if (other) {
        res.status(409).json({ error: 'This email is already registered.' });
        return;
      }
    }
    if (thirdEmailField.present && thirdEmailNorm) {
      const other = await findCustomerIdByEmailExcluding(thirdEmailNorm, uid);
      if (other) {
        res.status(409).json({ error: 'This email is already registered.' });
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
      email: emailNorm,
      second_phone: secondPhoneNorm,
      third_phone: thirdPhoneNorm,
      second_email: secondEmailNorm,
      third_email: thirdEmailNorm,
    });
    if (emailChanged || secondEmailChanged || thirdEmailChanged) {
      const flags: string[] = [];
      if (emailChanged) flags.push('email_verified = FALSE');
      if (secondEmailChanged) flags.push('second_email_verified = FALSE');
      if (thirdEmailChanged) flags.push('third_email_verified = FALSE');

      if (flags.length > 0) {
        await pool.query(`UPDATE customers SET ${flags.join(', ')} WHERE id = $1`, [uid]);
      }
    }
    await respondWithUser(req, res, uid);
  } catch (err) {
    console.error('patchProfile:', err);
    res.status(500).json({ error: 'Could not update profile.' });
  }
}

const CODE_TTL_MIN = 15;
const SALT_ROUNDS = 10;
const EMAIL_CODE_COOLDOWN_MS = 30_000;
const EMAIL_CODE_RATE_LIMIT_MAX = 10;

/** POST /api/v1/auth/profile/email/request-code */
export async function requestEmailChangeCode(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ ok: false, code: "UNAUTHENTICATED", error: "Not authenticated." });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const newEmail = pickString(body, ['new_email', 'newEmail', 'email']) ?? '';
    if (!isValidAsciiEmail(newEmail)) {
      res.status(400).json({ ok: false, code: "INVALID_EMAIL", error: "Invalid email address (ASCII only)." });
      return;
    }
    const row = await getCustomerRowById(uid);
    if (!row) {
      res.status(404).json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" });
      return;
    }
    const requestedEmail = newEmail.trim().toLowerCase();

    const currentPrimaryEmail = (row.email as string | null)?.trim().toLowerCase() ?? '';
    const currentSecondEmail = (row.second_email as string | null)?.trim().toLowerCase() ?? '';
    const currentThirdEmail = (row.third_email as string | null)?.trim().toLowerCase() ?? '';

    const matchesExistingEmail =
        requestedEmail === currentPrimaryEmail ||
        requestedEmail === currentSecondEmail ||
        requestedEmail === currentThirdEmail;

    if (!matchesExistingEmail) {
      const taken = await findCustomerIdByEmailExcluding(requestedEmail, uid);
      if (taken) {
        res.status(409).json({ ok: false, code: "EMAIL_TAKEN", error: "This email is already registered." });
        return;
      }
    }

  const pendingCheck = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM email_change_pending WHERE customer_id = $1`,
      [uid]
  );
  const pendingCreatedAt = pendingCheck.rows[0]?.created_at;
  if (pendingCreatedAt) {
    const ageMs = Date.now() - new Date(pendingCreatedAt).getTime();
    if (ageMs >= 0 && ageMs < EMAIL_CODE_COOLDOWN_MS) {
      res.status(429).json({
        ok: false,
        code: "EMAIL_CODE_COOLDOWN",
        error: "Please wait a bit before requesting another code.",
      });
      return;
    }
  }

  const rl = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
       FROM email_verification_request_log
       WHERE customer_id = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [uid]
  );
  const recentSends = rl.rows[0]?.c ?? 0;
  if (recentSends >= EMAIL_CODE_RATE_LIMIT_MAX) {
    res.status(429).json({
      ok: false,
      code: "EMAIL_CODE_RATE_LIMIT",
      error: "Too many verification requests. Please try again later.",
    });
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
      [uid, requestedEmail, code_hash, expiresAt]
    );

    await pool.query(`INSERT INTO email_verification_request_log (customer_id) VALUES ($1)`, [uid]);

    const sent = await sendEmailChangeCode(requestedEmail, code);
    if (!sent) {
      await pool.query(`DELETE FROM email_change_pending WHERE customer_id = $1`, [uid]);
      res.status(503).json({ ok: false, code: "EMAIL_DELIVERY_UNAVAILABLE", error: "Email is not configured on the server. Cannot send verification code." });
      return;
    }

    res.json({ ok: true, code: "EMAIL_CODE_SENT" });
  } catch (err) {
    console.error('requestEmailChangeCode:', err);
    res.status(500).json({ ok: false, code: "EMAIL_CODE_SEND_FAILED", error: "Could not send verification code." });
  }
}

/** POST /api/v1/auth/profile/email/confirm */
export async function confirmEmailChange(req: Request, res: Response): Promise<void> {
  const uid = req.user?.id;
  if (uid == null) {
    res.status(401).json({ ok: false, code: "UNAUTHENTICATED", error: "Not authenticated." });
    return;
  }
  try {
    const body = req.body as Record<string, unknown>;
    const rawEmail = pickString(body, ['new_email', 'newEmail', 'email']) ?? '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const requestedEmail = rawEmail.trim().toLowerCase();
    if (!isValidAsciiEmail(requestedEmail) || !code) {
      res.status(400).json({ ok: false, code: "INVALID_EMAIL_OR_CODE", error: "Invalid email or code." });
      return;
    }

    const result = await pool.query(
      `SELECT id, new_email, code_hash, expires_at FROM email_change_pending WHERE customer_id = $1`,
      [uid]
    );
    const pending = result.rows[0];
    if (!pending) {
      res.status(400).json({ ok: false, code: "NO_PENDING_EMAIL_CHANGE", error: "No pending email change. Request a new code." });
      return;
    }
    if (pending.new_email !== requestedEmail) {
      res.status(400).json({ ok: false, code: "PENDING_EMAIL_MISMATCH", error: "Email does not match pending change." });
      return;
    }
    if (new Date(pending.expires_at) < new Date()) {
      await pool.query(`DELETE FROM email_change_pending WHERE customer_id = $1`, [uid]);
      res.status(400).json({ ok: false, code: "EMAIL_CODE_EXPIRED", error: "Code expired. Request a new code." });
      return;
    }
    const ok = await bcrypt.compare(code, pending.code_hash);
    if (!ok) {
      res.status(400).json({ error: 'Invalid verification code.' });
      return;
    }

    const taken = await findCustomerIdByEmailExcluding(requestedEmail, uid);
    if (taken) {
      res.status(409).json({ ok: false, code: "EMAIL_TAKEN", error: "This email is already registered." });
      return;
    }

    const profileRow = await getCustomerRowById(uid);
    if (!profileRow) {
      res.status(404).json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" });
      return;
    }

    const curPrimary = ((profileRow.email as string | null) ?? '').trim().toLowerCase();
    const curSecond = ((profileRow.second_email as string | null) ?? '').trim().toLowerCase();
    const curThird = ((profileRow.third_email as string | null) ?? '').trim().toLowerCase();

    if (requestedEmail === curPrimary) {
      await pool.query(
          `UPDATE customers SET email = $1, email_verified = TRUE WHERE id = $2`,
          [requestedEmail, uid]
      );
    } else if (requestedEmail === curSecond) {
      await pool.query(
          `UPDATE customers SET second_email_verified = TRUE WHERE id = $1`,
          [uid]
      );
    } else if (requestedEmail === curThird) {
      await pool.query(
          `UPDATE customers SET third_email_verified = TRUE WHERE id = $1`,
          [uid]
      );
    } else {
      await pool.query(
          `UPDATE customers SET email = $1, email_verified = TRUE WHERE id = $2`,
          [requestedEmail, uid]
      );
    }

    await pool.query(`DELETE FROM email_change_pending WHERE customer_id = $1`, [uid]);

    const user = await getCustomerByIdSafe(uid);
    res.json({ ok: true, code: "EMAIL_CONFIRMED", user, data: { user } });
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
