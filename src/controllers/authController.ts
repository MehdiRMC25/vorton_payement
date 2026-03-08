import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { config } from '../config';
import {
  createCustomer,
  getCustomerByEmailOrPhone,
  getCustomerByIdSafe,
} from '../services/customerService';
import { assignSilverToNewCustomer, recalculateCustomerMembership, getCustomerMembership } from '../services/membershipService';

const SALT_ROUNDS = 10;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 150;
}

function isValidMobile(phone: string): boolean {
  try {
    const parsed = parsePhoneNumberWithError(phone);
    return parsed.isValid();
  } catch {
    return false;
  }
}

function membershipNumber(): string {
  return 'VORTON-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
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

function normalizePhone(input: string | null): string | null {
  if (!input) {
    return null;
  }
  return input.replace(/\s+/g, '');
}

/** POST /api/v1/auth/signup */
export async function signup(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const fullName = pickString(body, ['full_name', 'fullName', 'name']);
    const firstName = pickString(body, ['first_name', 'firstName']);
    const lastName = pickString(body, ['last_name', 'lastName']);
    const phone = normalizePhone(pickString(body, ['phone', 'phoneNumber', 'mobile', 'mobileNumber', 'mobile_number']));
    const secondPhone = normalizePhone(pickString(body, ['second_phone', 'secondPhone', 'second_mobile', 'mobile_secondary']));
    const email = pickString(body, ['email']);
    const password = pickString(body, ['password']);
    const confirmPassword = pickString(body, ['confirm_password', 'confirmPassword', 'passwordConfirmation', 'password_confirmation']) ?? password;
    const addressLine1 = pickString(body, ['address_line1', 'addressLine1']);
    const addressLine2 = pickString(body, ['address_line2', 'addressLine2']);
    const address = pickString(body, ['address']);
    const city = pickString(body, ['city']);
    const postcode = pickString(body, ['postcode', 'postal_code', 'postalCode', 'zip', 'zipCode']);
    const country = pickString(body, ['country']);

    if (!phone) {
      res.status(400).json({ error: 'Mobile number is required.' });
      return;
    }
    if (!isValidMobile(phone)) {
      res.status(400).json({ error: 'Invalid mobile number' });
      return;
    }
    if (email && !isValidEmail(email)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    if (!password || password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters.' });
      return;
    }
    if (password !== confirmPassword) {
      res.status(400).json({ error: 'Password and confirm password do not match.' });
      return;
    }

    let first_name: string;
    let last_name: string;
    if (firstName && lastName) {
      first_name = firstName;
      last_name = lastName;
    } else if (fullName) {
      const parts = fullName.trim().split(/\s+/);
      first_name = parts[0] ?? '';
      last_name = parts.slice(1).join(' ') || first_name;
    } else {
      res.status(400).json({ error: 'Full name or first name and last name are required.' });
      return;
    }

    const existingByPhone = await getCustomerByEmailOrPhone(phone);
    if (existingByPhone) {
      res.status(409).json({ error: 'Account already exists. Please sign in.' });
      return;
    }
    if (email) {
      const existingByEmail = await getCustomerByEmailOrPhone(email);
      if (existingByEmail) {
        res.status(409).json({ error: 'Account already exists. Please sign in.' });
        return;
      }
    }

    const password_salt = await bcrypt.genSalt(SALT_ROUNDS);
    const password_hash = await bcrypt.hash(password, password_salt);
    const membership_number = membershipNumber();

    const row = await createCustomer({
      first_name,
      last_name,
      email,
      phone,
      second_phone: secondPhone ?? null,
      password_hash,
      password_salt,
      membership_number,
      address_line1: addressLine1 || (address || null),
      address_line2: addressLine2 || null,
      city,
      postcode,
      country,
    });

    await assignSilverToNewCustomer(row.id);

    const user = await getCustomerByIdSafe(row.id);
    const jwtKey = config.jwtSecret || config.authSecret;
    const token = jwtKey
      ? jwt.sign({ sub: row.id }, jwtKey, { expiresIn: '7d' })
      : null;

    if (!token) {
      console.warn('Signup succeeded but no JWT: set JWT_SECRET or AUTH_SECRET in environment');
    }

    res.status(201).json({
      user,
      token,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Sign up is not available yet. Please try again later.' });
  }
}

/** POST /api/v1/auth/login */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const loginIdRaw = pickString(body, ['email', 'phone', 'phoneNumber', 'mobile', 'mobileNumber', 'mobile_number', 'login', 'username']);
    const loginId = loginIdRaw?.includes('@') ? loginIdRaw : normalizePhone(loginIdRaw);
    const password = pickString(body, ['password']);

    if (!loginId || !password) {
      res.status(400).json({ error: 'Email or mobile number and password are required.' });
      return;
    }
    if (loginId.includes('@')) {
      if (!isValidEmail(loginId)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
      }
    } else {
      if (!isValidMobile(loginId)) {
        res.status(400).json({ error: 'Invalid mobile number' });
        return;
      }
    }

    const customer = await getCustomerByEmailOrPhone(loginId);
    if (!customer) {
      res.status(401).json({ error: 'Account not found' });
      return;
    }

    let match = false;
    try {
      match = customer.password_hash
        ? await bcrypt.compare(password, customer.password_hash)
        : false;
    } catch {
      match = false;
    }
    if (!match) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const user = await getCustomerByIdSafe(customer.id);
    const jwtKey = config.jwtSecret || config.authSecret;
    const token = jwtKey
      ? jwt.sign({ sub: customer.id }, jwtKey, { expiresIn: '7d' })
      : null;

    if (!token) {
      console.warn('Login succeeded but no JWT: set JWT_SECRET or AUTH_SECRET in environment');
    }

    res.json({
      user,
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again later.' });
  }
}

/** GET /api/v1/auth/me - requires Authorization: Bearer <token> */
export async function me(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const jwtKey = config.jwtSecret || config.authSecret;
  if (!token || !jwtKey) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }
  try {
    const decoded = jwt.verify(token, jwtKey) as { sub: number | string };
    const id = typeof decoded.sub === 'string' ? parseInt(decoded.sub, 10) : decoded.sub;
    const user = await getCustomerByIdSafe(id);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated.' });
      return;
    }
    await recalculateCustomerMembership(id);
    const membership = await getCustomerMembership(id);
    res.json({ user, membership });
  } catch {
    res.status(401).json({ error: 'Not authenticated.' });
  }
}
