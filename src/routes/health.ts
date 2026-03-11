import { Router } from 'express';
import { pool } from '../db';
import { config } from '../config';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'payment-backend',
  });
});

/** Check DB, orders, payment_intents — use to verify payment flow. */
healthRouter.get('/payments', async (_req, res) => {
  try {
    const dbResult = await pool.query('SELECT current_database() AS name');
    const ordersResult = await pool.query('SELECT count(*)::int AS n FROM orders');
    const intentsResult = await pool.query('SELECT count(*)::int AS n FROM payment_intents');
    const hasBank = Boolean(
      config.bank.gatewayUrl && config.bank.username && config.bank.password
    );
    res.json({
      connected: true,
      database: dbResult.rows[0]?.name ?? null,
      ordersCount: ordersResult.rows[0]?.n ?? 0,
      paymentIntentsCount: intentsResult.rows[0]?.n ?? 0,
      kapitalConfigured: hasBank,
    });
  } catch (err) {
    console.error('Health payments check failed:', err);
    res.status(500).json({
      connected: false,
      error: err instanceof Error ? err.message : 'Database error',
    });
  }
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
