import { Request, Response } from 'express';
import {
  createPaymentIntent,
  getPaymentStatus,
  getPaymentByBankOrderId,
  getPaymentByBankOrderIdFromDb,
  confirmAndPersistPaymentStatus,
  getCreatedOrderIdForBankOrder,
  persistOrderIdForPayment,
  type PendingOrderPayload,
} from '../services/paymentService';
import { validatePaymentAmountForOrder } from '../services/paymentOrderValidation';
import { getTransactionDetails } from '../services/kapitalService';
import * as orderService from '../services/orderService';
import { tryAwardRewardPointsForOrder } from '../services/rewardPointsService';
import { sendCustomerPurchaseConfirmation, sendOrderNotification } from '../services/emailService';
import { emitOrderCreated } from '../socket';
import { linkDeliveryLogToOrder } from '../services/deliveryContactLogService';

/** Avoid sending HTML blobs or multi-KB strings to browsers. */
function sanitizePaymentErrorForClient(message: string): string {
  if (!message || message.length > 600) {
    return 'Payment could not be started. Please try again later.';
  }
  if (/<!DOCTYPE|<\s*html/i.test(message)) {
    return 'The payment service returned an unexpected response. Please try again later.';
  }
  return message;
}

export async function create(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const hasOrder = body && typeof body.order === 'object' && body.order !== null;
    console.log('[Payment] Create request: hasOrder=', hasOrder);
    if (hasOrder) {
      try {
        await validatePaymentAmountForOrder(Number(body.amount), body.order as PendingOrderPayload);
      } catch (ve) {
        const payload = (ve as Error & { payload?: Record<string, unknown> }).payload;
        if (payload && typeof payload === 'object') {
          res.status(400).json(payload);
          return;
        }
        const msg = ve instanceof Error ? ve.message : 'Invalid payment amount for order';
        res.status(400).json({ error: msg });
        return;
      }
    }
    const result = await createPaymentIntent(req.body);
    console.log('[Payment] Create succeeded: bankOrderId=', (result as { bankOrderId?: string }).bankOrderId);
    res.status(201).json(result);
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Payment creation failed';
    const message = sanitizePaymentErrorForClient(raw);
    console.error('[Payment] Create failed:', raw);
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
  let createdOrder: Record<string, unknown> | null = null;
  if (updated?.status === 'succeeded' && updated?.orderPayload) {
    try {
      const existingOrderId = await getCreatedOrderIdForBankOrder(bankOrderId);
      if (existingOrderId) {
        const order = await orderService.getOrderById(existingOrderId);
        if (order) {
          createdOrder = order;
          console.log('[Payment] Returning existing order for bank order', bankOrderId, order.order_number);
          const p = updated.orderPayload as PendingOrderPayload;
          const logIdRetry =
            typeof p.delivery_contact_log_id === 'number' && Number.isFinite(p.delivery_contact_log_id)
              ? Math.floor(p.delivery_contact_log_id)
              : undefined;
          const custIdRetry = typeof p.customer_id === 'number' ? p.customer_id : undefined;
          if (logIdRetry != null && logIdRetry > 0 && custIdRetry != null) {
            await linkDeliveryLogToOrder(logIdRetry, String(order.id), custIdRetry);
          }
        }
      } else {
        const p = updated.orderPayload;
        try {
          await validatePaymentAmountForOrder(updated.amount, p);
        } catch (ve) {
          console.error('[Payment] Amount/order mismatch on confirm:', ve);
          throw ve;
        }
        console.log('[Payment] Creating order for bank order', bankOrderId);
        const pts =
          typeof p.points_to_redeem === 'number' && Number.isFinite(p.points_to_redeem)
            ? Math.floor(p.points_to_redeem)
            : 0;
        const result = await orderService.createOrder({
          customer_id: typeof p.customer_id === 'number' ? p.customer_id : undefined,
          customer_name: p.customer_name,
          mobile: p.mobile,
          membership_level: p.membership_level ?? 'none',
          address: p.address ?? null,
          items: p.items,
          total_price: p.total_price,
          delivery_due_date: p.delivery_due_date ?? null,
          points_to_redeem: pts > 0 ? pts : undefined,
        });
        const logId =
          typeof p.delivery_contact_log_id === 'number' && Number.isFinite(p.delivery_contact_log_id)
            ? Math.floor(p.delivery_contact_log_id)
            : undefined;
        const custId = typeof p.customer_id === 'number' ? p.customer_id : undefined;
        if (logId != null && logId > 0 && custId != null) {
          await linkDeliveryLogToOrder(logId, result.id, custId);
        }
        let order = await orderService.getOrderById(result.id);
        if (order) {
          await persistOrderIdForPayment(bankOrderId, result.id);
          await tryAwardRewardPointsForOrder({
            id: String(order.id),
            customer_id: order.customer_id != null ? Number(order.customer_id) : null,
            items: Array.isArray(order.items) ? (order.items as orderService.OrderItem[]) : [],
          });
          const refreshed = await orderService.getOrderById(result.id);
          createdOrder = refreshed ?? order;
          emitOrderCreated(createdOrder);
          void sendOrderNotification(createdOrder);
          void sendCustomerPurchaseConfirmation(createdOrder);
        }
        console.log('[Payment] Order created:', result.order_number);
      }
    } catch (err) {
      const e = err as { message?: string; detail?: string; code?: string };
      console.error('[Payment] Create order on confirm failed:', e?.message || err, e?.detail || '');
    }
  } else {
    console.log('[Payment] Confirm skipped order creation: status=', updated?.status, 'hasOrderPayload=', !!updated?.orderPayload);
  }
  const payload = updated ?? payment;
  res.json(createdOrder ? { ...payload, createdOrder } : payload);
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
