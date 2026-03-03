import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { paymentRouter } from './routes/payments';
import { webhookRouter } from './routes/webhooks';
import { healthRouter } from './routes/health';

const app = express();

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

app.get('/', (_req, res) => {
  res.json({
    name: 'Payment Backend API',
    version: '1.0.0',
    docs: config.apiPrefix + '/health',
    usage: 'Use ' + config.apiPrefix + '/payments for payment endpoints.',
  });
});

app.listen(config.port, () => {
  console.log(`Payment backend running on port ${config.port}`);
  console.log(`API base: ${config.apiPrefix}`);
});
