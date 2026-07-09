import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool } from '../db';
import { getCustomerByAnyEmail, updateCustomerPassword } from '../services/customerService';
import { sendPasswordResetCode } from '../services/emailService';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const CODE_TTL_MIN = 15;
const SALT_ROUNDS = 10;
const EMAIL_CODE_COOLDOWN_MS = 30_000;
const EMAIL_CODE_RATE_LIMIT_MAX = 5;

function isValidAsciiEmail(email: string): boolean {
  if (!email || email.length > 150) return false;
  if (/[^\x00-\x7F]/.test(email)) return false;
  return EMAIL_RE.test(email.trim());
}

function normalizeEmail(input: string | null): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return e || null;
}

function pickString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function emailMatchesCustomer(row: Record<string, unknown>, email: string): boolean {
  const target = email.trim().toLowerCase();
  const slots = [row.email, row.second_email, row.third_email]
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
      .filter(Boolean);
  return slots.includes(target);
}

/** POST /api/v1/auth/password/forgot */
export async function requestPasswordResetCode(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const emailRaw = pickString(body, ['email', 'emailAddress']);
    if (!emailRaw || !isValidAsciiEmail(emailRaw)) {
      res.status(400).json({ ok: false, code: 'INVALID_EMAIL', error: 'Invalid email address (ASCII only).' });
      return;
    }
    const email = normalizeEmail(emailRaw);
    if (!email) {
      res.status(400).json({ ok: false, code: 'INVALID_EMAIL', error: 'Invalid email address (ASCII only).' });
      return;
    }

    const customer = await getCustomerByAnyEmail(email);
    if (!customer || !emailMatchesCustomer(customer, email)) {
      res.status(404).json({
        ok: false,
        code: 'EMAIL_NOT_REGISTERED',
        error: 'This email address is not registered.',
      });
      return;
    }

    const customerId = Number(customer.id);
    const pending = await pool.query<{ created_at: Date }>(
        `SELECT created_at FROM password_reset_pending WHERE customer_id = $1 AND email = $2`,
        [customerId, email]
    );
    const pendingCreatedAt = pending.rows[0]?.created_at;
    if (pendingCreatedAt) {
      const ageMs = Date.now() - new Date(pendingCreatedAt).getTime();
      if (ageMs >= 0 && ageMs < EMAIL_CODE_COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((EMAIL_CODE_COOLDOWN_MS - ageMs) / 1000);
        res.status(429).json({
          ok: false,
          code: 'EMAIL_CODE_COOLDOWN',
          error: 'Please wait a bit before requesting another code.',
          retryAfterSec,
        });
        return;
      }
    }

    const rl = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
       FROM password_reset_request_log
       WHERE customer_id = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
        [customerId]
    );
    if ((rl.rows[0]?.c ?? 0) >= EMAIL_CODE_RATE_LIMIT_MAX) {
      res.status(429).json({
        ok: false,
        code: 'EMAIL_CODE_RATE_LIMIT',
        error: 'Too many verification requests. Please try again later.',
      });
      return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const code_hash = await bcrypt.hash(code, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000);

    await pool.query(`DELETE FROM password_reset_pending WHERE customer_id = $1`, [customerId]);
    await pool.query(
        `INSERT INTO password_reset_pending (customer_id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
        [customerId, email, code_hash, expiresAt]
    );
    await pool.query(`INSERT INTO password_reset_request_log (customer_id) VALUES ($1)`, [customerId]);

    const sent = await sendPasswordResetCode(email, code);
    if (!sent) {
      await pool.query(`DELETE FROM password_reset_pending WHERE customer_id = $1`, [customerId]);
      res.status(503).json({
        ok: false,
        code: 'EMAIL_CODE_SEND_FAILED',
        error: 'Could not send verification code.',
      });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Request password reset error:', err);
    res.status(500).json({ error: 'Could not send password reset code. Please try again later.' });
  }
}

/** POST /api/v1/auth/password/reset */
export async function resetPasswordWithCode(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const emailRaw = pickString(body, ['email', 'emailAddress']);
    const code = pickString(body, ['code', 'verification_code', 'verificationCode']);
    const password = pickString(body, ['password', 'new_password', 'newPassword']);
    const confirmPassword =
        pickString(body, ['confirm_password', 'confirmPassword', 'password_confirmation']) ?? password;

    if (!emailRaw || !isValidAsciiEmail(emailRaw)) {
      res.status(400).json({ ok: false, code: 'INVALID_EMAIL', error: 'Invalid email address (ASCII only).' });
      return;
    }
    const email = normalizeEmail(emailRaw);
    if (!email || !code) {
      res.status(400).json({ ok: false, code: 'INVALID_EMAIL_OR_CODE', error: 'Invalid email or verification code.' });
      return;
    }
    if (!password || password.length < 6) {
      res.status(400).json({ ok: false, code: 'INVALID_PASSWORD', error: 'Password must be at least 6 characters.' });
      return;
    }
    if (password !== confirmPassword) {
      res.status(400).json({ ok: false, code: 'PASSWORD_MISMATCH', error: 'Password and confirm password do not match.' });
      return;
    }

    const customer = await getCustomerByAnyEmail(email);
    if (!customer || !emailMatchesCustomer(customer, email)) {
      res.status(404).json({
        ok: false,
        code: 'EMAIL_NOT_REGISTERED',
        error: 'This email address is not registered.',
      });
      return;
    }

    const customerId = Number(customer.id);
    const pending = await pool.query<{
      code_hash: string;
      expires_at: Date;
    }>(`SELECT code_hash, expires_at FROM password_reset_pending WHERE customer_id = $1 AND email = $2`, [
      customerId,
      email,
    ]);
    const row = pending.rows[0];
    if (!row) {
      res.status(400).json({
        ok: false,
        code: 'NO_PENDING_PASSWORD_RESET',
        error: 'No pending password reset. Request a new code.',
      });
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query(`DELETE FROM password_reset_pending WHERE customer_id = $1`, [customerId]);
      res.status(400).json({ ok: false, code: 'EMAIL_CODE_EXPIRED', error: 'Code expired. Please request a new code.' });
      return;
    }

    const match = await bcrypt.compare(code, row.code_hash);
    if (!match) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_VERIFICATION_CODE',
        error: 'Invalid verification code.',
      });
      return;
    }

    const password_salt = await bcrypt.genSalt(SALT_ROUNDS);
    const password_hash = await bcrypt.hash(password, password_salt);
    await updateCustomerPassword(customerId, password_hash, password_salt);
    await pool.query(`DELETE FROM password_reset_pending WHERE customer_id = $1`, [customerId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset password. Please try again later.' });
  }
}