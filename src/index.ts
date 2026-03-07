import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { paymentRouter } from './routes/payments';
import { webhookRouter } from './routes/webhooks';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
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

  app.listen(config.port, () => {
    console.log(`Payment backend running on port ${config.port}`);
    console.log(`API base: ${config.apiPrefix}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
