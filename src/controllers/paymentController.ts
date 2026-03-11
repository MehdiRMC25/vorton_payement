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
    const body = req.body as Record<string, unknown>;
    const hasOrder = body && typeof body.order === 'object' && body.order !== null;
    console.log('[Payment] Create request: hasOrder=', hasOrder);
    const result = await createPaymentIntent(req.body);
    console.log('[Payment] Create succeeded: bankOrderId=', (result as { bankOrderId?: string }).bankOrderId);
    res.status(201).json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Payment creation failed';
    console.error('[Payment] Create failed:', message);
    res.status(500).json({ error: message });
  }
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const bankOrderId = String(req.query.ID);
  const callbackStatus = String(req.query.STATUS);
  // Check memory first, then DB (survives server restarts, e.g. Render cold start)
  let payment = getPaymentByBankOrderId(bankOrderId);
  const fromDb = !payment;
  if (!payment) {
    payment = await getPaymentByBankOrderIdFromDb(bankOrderId);
  }
  if (payment) {
    console.log('[Payment] Confirm: found payment from', fromDb ? 'DB' : 'memory');
  }
  if (!payment) {
    console.warn('[Payment] Payment not found for bank order', bankOrderId);
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
      console.log('[Payment] Creating order for bank order', bankOrderId);
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
      console.log('[Payment] Order created:', result.order_number);
    } catch (err) {
      console.error('[Payment] Create order on confirm failed:', err);
    }
  } else {
    console.log('[Payment] Confirm skipped order creation: status=', updated?.status, 'hasOrderPayload=', !!updated?.orderPayload);
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
