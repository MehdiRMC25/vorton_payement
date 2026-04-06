import { pool } from '../db';

/**
 * After an order is created from payment, link the checkout delivery log row to that order.
 * Only updates if the row belongs to the customer and is not already linked.
 */
export async function linkDeliveryLogToOrder(
  logId: number,
  orderId: string,
  customerId: number
): Promise<void> {
  if (!Number.isFinite(logId) || logId <= 0 || !orderId?.trim()) {
    return;
  }
  const result = await pool.query(
    `UPDATE customer_delivery_contact_log
     SET order_id = $1::uuid
     WHERE id = $2 AND customer_id = $3 AND order_id IS NULL`,
    [orderId.trim(), logId, customerId]
  );
  if (result.rowCount === 0) {
    console.warn(
      '[DeliveryLog] No row updated for log id',
      logId,
      'customer',
      customerId,
      'order',
      orderId
    );
  }
}
