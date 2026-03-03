import { Request, Response } from 'express';
import {
  createPaymentIntent,
  getPaymentStatus,
  getPaymentByBankOrderId,
  confirmPaymentByBankOrder,
} from '../services/paymentService';
import { getTransactionDetails } from '../services/kapitalService';

export async function create(req: Request, res: Response): Promise<void> {
  try {
    const result = await createPaymentIntent(req.body);
    res.status(201).json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Payment creation failed';
    res.status(500).json({ error: message });
  }
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const bankOrderId = String(req.query.ID);
  const callbackStatus = String(req.query.STATUS);
  const payment = getPaymentByBankOrderId(bankOrderId);
  if (!payment) {
    res.status(404).json({ error: 'Payment not found for this bank order' });
    return;
  }
  // Do not trust callback STATUS alone — verify with Transaction Details when available.
  const verified = await getTransactionDetails(bankOrderId);
  const statusToUse = verified?.status ?? callbackStatus;
  const updated = confirmPaymentByBankOrder(bankOrderId, statusToUse);
  res.json(updated ?? payment);
}

export async function getStatus(req: Request, res: Response): Promise<void> {
  try {
    const payment = await getPaymentStatus(req.params.paymentId);
    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    res.json(payment);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to get payment status';
    res.status(500).json({ error: message });
  }
}
