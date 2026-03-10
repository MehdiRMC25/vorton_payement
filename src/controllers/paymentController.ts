import { Request, Response } from 'express';
import {
  createPaymentIntent,
  getPaymentStatus,
  getPaymentByBankOrderId,
  getPaymentByBankOrderIdFromDb,
  confirmAndPersistPaymentStatus,
} from '../services/paymentService';
import { getTransactionDetails } from '../services/kapitalService';
import * as orderService from '../services/orderService';
import { emitOrderCreated } from '../socket';

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
  // Check memory first, then DB (survives server restarts, e.g. Render cold start)
  let payment = getPaymentByBankOrderId(bankOrderId);
  if (!payment) {
    payment = await getPaymentByBankOrderIdFromDb(bankOrderId);
  }
  if (!payment) {
    console.warn('[Payment] Payment not found for bank order', bankOrderId, '— run sql/payment-intents.sql if backend restarts between checkout and confirm');
    res.status(404).json({ error: 'Payment not found for this bank order' });
    return;
  }
  // Do not trust callback STATUS alone — verify with Transaction Details when available.
  const verified = await getTransactionDetails(bankOrderId);
  const statusToUse = verified?.status ?? callbackStatus;
  const updated = await confirmAndPersistPaymentStatus(payment, statusToUse);
  if (updated?.status === 'succeeded' && updated?.orderPayload) {
    try {
      const p = updated.orderPayload;
      const result = await orderService.createOrder({
        customer_id: typeof p.customer_id === 'number' ? p.customer_id : undefined,
        customer_name: p.customer_name,
        mobile: p.mobile,
        membership_level: p.membership_level ?? 'none',
        address: p.address ?? null,
        items: p.items,
        total_price: p.total_price,
        delivery_due_date: p.delivery_due_date ?? null,
      });
      const order = await orderService.getOrderById(result.id);
      if (order) emitOrderCreated(order);
    } catch (err) {
      console.error('Create order on payment confirm:', err);
    }
  }
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
