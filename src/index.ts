import http from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { paymentRouter } from './routes/payments';
import { webhookRouter } from './routes/webhooks';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { ordersRouter } from './routes/orders';
import { productsRouter } from './routes/products';
import { checkoutRouter } from './routes/checkout';
import { setIO } from './socket';
import { syncStaffAccounts } from './services/staffAccountsService';
import * as authController from './controllers/authController';

const app = express();

app.set('trust proxy', true);
app.use(helmet());
app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
app.use(cors({
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  credentials: true,
}));
app.use(express.json());

app.use(config.apiPrefix + '/health', healthRouter);
app.use(config.apiPrefix + '/payments', paymentRouter);
app.use(config.apiPrefix + '/webhooks', webhookRouter);
app.use(config.apiPrefix + '/auth', authRouter);
app.use(config.apiPrefix + '/checkout', checkoutRouter);
app.use(config.apiPrefix + '/orders', ordersRouter);
app.use('/api', productsRouter);
app.post('/auth/signup', authController.signup);
app.post('/auth/login', authController.login);
app.get('/auth/signup', (_req, res) => {
  res.status(200).json({
    message: 'This is the signup API. Use POST with JSON body from your frontend. The signup form page is on your app (e.g. yoursite.com/signup).',
    method: 'POST',
    url: '/auth/signup',
  });
});
app.get('/auth/login', (_req, res) => {
  res.status(200).json({
    message: 'This is the login API. Use POST with JSON body from your frontend. The login form page is on your app (e.g. yoursite.com/login).',
    method: 'POST',
    url: '/auth/login',
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Payment Backend API',
    version: '1.0.0',
    docs: config.apiPrefix + '/health',
    usage: 'Use ' + config.apiPrefix + '/payments for payment endpoints.',
    auth: config.authSecret ? config.apiPrefix + '/auth/session' : undefined,
  });
});

async function start(): Promise<void> {
  try {
    const result = await syncStaffAccounts();
    if (result.synced === 0 && result.errors.length === 0) {
      console.log('[Staff] No staff file found at', config.staffAccountsFile, '— set STAFF_ACCOUNTS_FILE or add config/staff-accounts.json and restart.');
    }
  } catch (e) {
    console.warn('[Staff] Sync failed (staff login may not work):', e);
  }

  if (!config.jwtSecret && !config.authSecret) {
    console.warn('No JWT_SECRET or AUTH_SECRET set: login/signup will return token: null. Set one in Environment for tokens.');
  }
  if (config.database.url) {
    try {
      const u = new URL(config.database.url);
      console.log('Database: using DATABASE_URL (host: ' + u.hostname + ')');
    } catch {
      console.log('Database: using DATABASE_URL (url set)');
    }
  } else {
    console.log('Database: using PGHOST (host: ' + config.database.host + ':' + config.database.port + ')');
  }

  // Check payment_intents table exists (needed for order creation after server restarts)
  if (config.database.url || config.database.host) {
    try {
      const { pool } = await import('./db');
      await pool.query('SELECT 1 FROM payment_intents LIMIT 1');
      await pool.query('ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS order_id VARCHAR(50)');
      console.log('[Payment] payment_intents table OK — orders will be created after restarts');
    } catch (e) {
      console.warn('[Payment] Run sql/payment-intents.sql on your database so new orders from payments are created after server restarts.');
    }
    try {
      const { pool: poolReward } = await import('./db');
      await poolReward.query(
        'ALTER TABLE customers ADD COLUMN IF NOT EXISTS reward_points_balance INT NOT NULL DEFAULT 0'
      );
      await poolReward.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_earned INT NOT NULL DEFAULT 0');
      await poolReward.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed INT NOT NULL DEFAULT 0'
      );
      await poolReward.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS reward_discount_azn NUMERIC(12,2) NOT NULL DEFAULT 0'
      );
      await poolReward.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS membership_discount_azn NUMERIC(12,2) NOT NULL DEFAULT 0'
      );
      await poolReward.query(`
        CREATE TABLE IF NOT EXISTS reward_points_ledger (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          order_id VARCHAR(64) NOT NULL,
          points_delta INT NOT NULL,
          balance_after INT NOT NULL,
          reward_azn NUMERIC(12,4),
          tier_percent NUMERIC(5,2),
          eligible_subtotal_azn NUMERIC(12,2),
          reason VARCHAR(80) NOT NULL DEFAULT 'purchase',
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (order_id, reason)
        )
      `);
      await poolReward.query(
        'CREATE INDEX IF NOT EXISTS idx_reward_points_ledger_customer_id ON reward_points_ledger(customer_id)'
      );
      console.log('[RewardPoints] Schema OK — customer balances and ledger');
    } catch (e) {
      console.warn('[RewardPoints] Schema setup skipped:', e instanceof Error ? e.message : e);
    }
    try {
      const { pool: poolProfile } = await import('./db');
      await poolProfile.query(`
        CREATE TABLE IF NOT EXISTS email_change_pending (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          new_email VARCHAR(255) NOT NULL,
          code_hash VARCHAR(255) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(customer_id)
        )
      `);
      await poolProfile.query(`
        CREATE TABLE IF NOT EXISTS customer_delivery_contact_log (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          phone VARCHAR(64),
          address_text TEXT,
          source VARCHAR(32) NOT NULL DEFAULT 'checkout',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await poolProfile.query(
        `ALTER TABLE customer_delivery_contact_log
         ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL`
      );
      await poolProfile.query(
        'CREATE INDEX IF NOT EXISTS idx_delivery_contact_customer ON customer_delivery_contact_log(customer_id)'
      );
      await poolProfile.query(
        'CREATE INDEX IF NOT EXISTS idx_delivery_contact_order_id ON customer_delivery_contact_log(order_id)'
      );
      console.log('[Profile] email_change_pending and customer_delivery_contact_log OK');
    } catch (e) {
      console.warn('[Profile] Schema setup skipped:', e instanceof Error ? e.message : e);
    }
    try {
      const { pool: poolCart } = await import('./db');
      await poolCart.query(`
        CREATE TABLE IF NOT EXISTS cart_items (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL,
          sku_color TEXT NOT NULL,
          size TEXT NOT NULL,
          quantity INT NOT NULL CHECK (quantity > 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, sku_color, size)
        )
      `);
      await poolCart.query(
        'CREATE INDEX IF NOT EXISTS cart_items_user_id_idx ON cart_items(user_id)'
      );
      console.log('[Cart] cart_items table OK');
    } catch (e) {
      console.warn('[Cart] Schema setup skipped:', e instanceof Error ? e.message : e);
    }
  }

  // Log Kapital Bank config (payments only persist when real bank is used)
  const hasBank = Boolean(config.bank.gatewayUrl && config.bank.username && config.bank.password);
  if (hasBank) {
    console.log('[Payment] Kapital Bank configured — payments will persist to payment_intents');
  } else {
    console.warn('[Payment] Kapital Bank not configured (KAPITAL_BASE_URL, USERNAME, PASSWORD) — payments stay in memory only, orders lost on restart');
  }

  if (config.authSecret) {
    const { ExpressAuth, getSession } = await import('@auth/express');
    const GitHub = (await import('@auth/express/providers/github')).default;
    const authConfig = {
      secret: config.authSecret,
      providers: config.authGitHub.clientId && config.authGitHub.clientSecret
        ? [GitHub({ clientId: config.authGitHub.clientId, clientSecret: config.authGitHub.clientSecret })]
        : [],
    };
    app.use('/auth', ExpressAuth(authConfig));
    app.get(config.apiPrefix + '/auth/session', async (req, res) => {
      const session = await getSession(req, authConfig);
      if (!session?.user) {
        res.status(401).json({ signedIn: false });
        return;
      }
      res.json({ signedIn: true, user: session.user });
    });
    console.log('Auth.js mounted at /auth and ' + config.apiPrefix + '/auth/session');
  }

  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: { origin: config.corsOrigins.length > 0 ? config.corsOrigins : true, credentials: true },
  });
  setIO(io);

  server.listen(config.port, () => {
    console.log(`Payment backend running on port ${config.port}`);
    console.log(`API base: ${config.apiPrefix}`);
    console.log('Socket.io attached for real-time order updates (order_created, order_status_updated)');
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
