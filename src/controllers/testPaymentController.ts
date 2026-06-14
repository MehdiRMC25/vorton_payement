import { Request, Response } from 'express';
import {
    getPaymentByBankOrderId,
    getPaymentByBankOrderIdFromDb,
    confirmAndPersistPaymentStatus,
    getCreatedOrderIdForBankOrder,
    persistOrderIdForPayment,
    type PendingOrderPayload,
} from '../services/paymentService';
import { validatePaymentAmountForOrder } from '../services/paymentOrderValidation';
import * as orderService from '../services/orderService';
import { tryAwardRewardPointsForOrder } from '../services/rewardPointsService';
import { sendCustomerPurchaseConfirmation, sendOrderNotification } from '../services/emailService';
import { emitOrderCreated } from '../socket';
import { linkDeliveryLogToOrder } from '../services/deliveryContactLogService';

export async function forceSuccess(req: Request, res: Response): Promise<void> {
    const enabled = process.env.TEST_PAYMENT_ENABLED === '1';
    if (!enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
    }

    const bankOrderId = String((req.body as { bankOrderId?: unknown })?.bankOrderId ?? '').trim();
    if (!bankOrderId) {
        res.status(400).json({ error: 'bankOrderId is required' });
        return;
    }

    let payment = getPaymentByBankOrderId(bankOrderId);
    if (!payment) payment = await getPaymentByBankOrderIdFromDb(bankOrderId);

    if (!payment) {
        res.status(404).json({ error: 'Payment not found for bankOrderId' });
        return;
    }

    const updated = await confirmAndPersistPaymentStatus(payment, 'succeeded');

    let createdOrder: Record<string, unknown> | null = null;
    if (updated?.status === 'succeeded' && updated?.orderPayload) {
        const existingOrderId = await getCreatedOrderIdForBankOrder(bankOrderId);
        if (existingOrderId) {
            const order = await orderService.getOrderById(existingOrderId);
            if (order) createdOrder = order;
        } else {
            const p = updated.orderPayload as PendingOrderPayload;
            await validatePaymentAmountForOrder(updated.amount, p);

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
                delivery_city: p.delivery_city ?? null,
                delivery_country: p.delivery_country ?? null,
                checkout_currency: p.checkout_currency ?? null,
                promo_code: p.promo_code ?? null,
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
        }
    }

    res.json({ ok: true, bankOrderId, payment: updated ?? payment, createdOrder });
}