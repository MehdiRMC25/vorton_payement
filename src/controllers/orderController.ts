import { Request, Response } from 'express';
import * as orderService from '../services/orderService';
import { emitOrderCreated, emitOrderStatusUpdated } from '../socket';

/** GET /orders - all orders (employee, manager) */
export async function listOrders(_req: Request, res: Response): Promise<void> {
  try {
    const orders = await orderService.getAllOrders();
    res.json({ orders });
  } catch (err) {
    console.error('List orders error:', err);
    res.status(500).json({ error: 'Failed to list orders' });
  }
}

/** GET /orders/stats - status overview (manager) */
export async function orderStats(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await orderService.getOrderStats();
    res.json({ stats });
  } catch (err) {
    console.error('Order stats error:', err);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
}

/** GET /orders/:id - single order (customer: own only; employee/manager: any) */
export async function getOrder(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const order = await orderService.getOrderById(id);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (req.user && req.user.role === 'customer' && Number(order.customer_id) !== req.user.id) {
      res.status(403).json({ error: 'You can only view your own orders' });
      return;
    }
    res.json(order);
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: 'Failed to get order' });
  }
}

/** GET /orders/customer/:customerId - orders for customer (customer only, own id) */
export async function getOrdersByCustomer(req: Request, res: Response): Promise<void> {
  try {
    const customerId = parseInt(req.params.customerId, 10);
    if (Number.isNaN(customerId)) {
      res.status(400).json({ error: 'Invalid customer id' });
      return;
    }
    if (req.user && req.user.id !== customerId && !['employee', 'manager', 'staff'].includes(req.user.role)) {
      res.status(403).json({ error: 'You can only view your own orders' });
      return;
    }
    const orders = await orderService.getOrdersByCustomerId(customerId);
    res.json({ orders });
  } catch (err) {
    console.error('Get customer orders error:', err);
    res.status(500).json({ error: 'Failed to get orders' });
  }
}

/** POST /orders - create order (checkout) */
export async function createOrder(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as Record<string, unknown>;
    const customer_id = Number(body.customer_id);
    const customer_name = String(body.customer_name ?? '');
    const mobile = String(body.mobile ?? '');
    const membership_level = String(body.membership_level ?? 'none');
    const address = body.address != null ? String(body.address) : null;
    const items = Array.isArray(body.items) ? body.items as orderService.OrderItem[] : [];
    const total_price = Number(body.total_price);
    const delivery_due_date = body.delivery_due_date != null ? String(body.delivery_due_date) : null;

    if (!customer_id || !customer_name || !mobile) {
      res.status(400).json({ error: 'customer_id, customer_name, and mobile are required' });
      return;
    }
    if (total_price < 0 || Number.isNaN(total_price)) {
      res.status(400).json({ error: 'total_price must be a non-negative number' });
      return;
    }

    const result = await orderService.createOrder({
      customer_id,
      customer_name,
      mobile,
      membership_level,
      address,
      items,
      total_price,
      delivery_due_date,
    });

    const order = await orderService.getOrderById(result.id);
    emitOrderCreated(order);

    res.status(201).json(order);
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
}

/** PATCH /orders/:id/status - update status (employee, manager) */
export async function updateStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const status = (req.body as Record<string, unknown>).status as string;
    if (!orderService.isAllowedStatus(status)) {
      res.status(400).json({ error: 'Invalid status. Allowed: PROCESSING, DISPATCHED, DELIVERED' });
      return;
    }
    const order = await orderService.updateOrderStatus(id, status);
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    emitOrderStatusUpdated(order);
    res.json(order);
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
}
