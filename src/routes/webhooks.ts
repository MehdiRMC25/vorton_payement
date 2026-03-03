import { Router, Request, Response } from 'express';
import { confirmPaymentByBankOrder } from '../services/paymentService';

export const webhookRouter = Router();

// Optional: if Kapital sends server-to-server webhooks with bank order ID and status
webhookRouter.post('/bank', (req: Request, res: Response) => {
  const body = req.body as { ID?: string; id?: string; STATUS?: string; status?: string };
  const bankOrderId = body.ID ?? body.id;
  const status = body.STATUS ?? body.status;
  if (bankOrderId && status) {
    confirmPaymentByBankOrder(String(bankOrderId), String(status));
  }
  res.status(200).json({ received: true });
});
