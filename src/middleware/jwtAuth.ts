import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getCustomerByIdSafe } from '../services/customerService';

export type Role = 'customer' | 'employee' | 'manager' | 'staff';

export interface AuthUser {
  id: number;
  role: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  [key: string]: unknown;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Require valid JWT and attach req.user (customer with role). */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const jwtKey = config.jwtSecret || config.authSecret;
  if (!token || !jwtKey) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const decoded = jwt.verify(token, jwtKey) as { sub: number | string };
    const id = typeof decoded.sub === 'string' ? parseInt(decoded.sub, 10) : decoded.sub;
    const user = await getCustomerByIdSafe(id);
    if (!user) {
      res.status(401).json({ error: 'Account not found' });
      return;
    }
    req.user = {
      id: user.id,
      role: (user.role || 'customer') as string,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Require one of the given roles. Call after requireAuth. */
export function requireRole(roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role as Role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
