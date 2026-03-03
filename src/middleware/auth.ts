import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'] ?? req.query.apiKey;
  if (!config.apiKey) {
    next();
    return;
  }
  if (key !== config.apiKey) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
}
