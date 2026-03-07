import { Router } from 'express';
import { pool } from '../db';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'payment-backend',
  });
});

/** Check which DB the backend uses and customer count. Use this to verify signups are in the right DB. */
healthRouter.get('/db', async (_req, res) => {
  try {
    const dbName = await pool.query('SELECT current_database() AS name');
    const count = await pool.query('SELECT count(*)::int AS n FROM customers');
    const last = await pool.query(
      'SELECT id, first_name, last_name, email, phone, created_at FROM customers ORDER BY id DESC LIMIT 3'
    );
    res.json({
      connected: true,
      database: dbName.rows[0]?.name ?? null,
      customerCount: count.rows[0]?.n ?? 0,
      latestCustomers: last.rows,
    });
  } catch (err) {
    console.error('Health DB check failed:', err);
    res.status(500).json({
      connected: false,
      error: err instanceof Error ? err.message : 'Database error',
    });
  }
});
