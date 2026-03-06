import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import {
  createCustomer,
  getCustomerByEmailOrPhone,
  getCustomerByIdSafe,
} from '../services/customerService';

const SALT_ROUNDS = 10;

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

    const existing = await getCustomerByEmailOrPhone(phone);
    if (existing) {
      res.status(409).json({ error: 'An account with this mobile number already exists.' });
      return;
    }
    if (email) {
      const byEmail = await getCustomerByEmailOrPhone(email);
      if (byEmail) {
        res.status(409).json({ error: 'An account with this email already exists.' });
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
      password_hash,
      password_salt,
      membership_number,
      address_line1: addressLine1 || (address || null),
      address_line2: addressLine2 || null,
      city,
      postcode,
      country,
    });

    const user = await getCustomerByIdSafe(row.id);
    const jwtKey = config.jwtSecret || config.authSecret;
    const token = jwtKey
      ? jwt.sign({ sub: row.id }, jwtKey, { expiresIn: '7d' })
      : null;

    res.status(201).json({
      user,
      ...(token && { token }),
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

    const customer = await getCustomerByEmailOrPhone(loginId);
    if (!customer) {
      res.status(401).json({ error: 'Such account does not exist or login or password are not correct.' });
      return;
    }

    const match = await bcrypt.compare(password, customer.password_hash);
    if (!match) {
      res.status(401).json({ error: 'Such account does not exist or login or password are not correct.' });
      return;
    }

    const user = await getCustomerByIdSafe(customer.id);
    const jwtKey = config.jwtSecret || config.authSecret;
    const token = jwtKey
      ? jwt.sign({ sub: customer.id }, jwtKey, { expiresIn: '7d' })
      : null;

    res.json({
      user,
      ...(token && { token }),
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
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Not authenticated.' });
  }
}
