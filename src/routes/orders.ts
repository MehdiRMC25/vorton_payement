import { Router } from 'express';
import { requireAuth, requireRole, type Role } from '../middleware/jwtAuth';
import * as orderController from '../controllers/orderController';

const router = Router();

const staffRoles: Role[] = ['employee', 'manager', 'staff'];
router.get('/', requireAuth, requireRole(staffRoles), orderController.listOrders);
router.get('/stats', requireAuth, requireRole(['manager'] as Role[]), orderController.orderStats);
router.get('/customer/:customerId', requireAuth, orderController.getOrdersByCustomer);
router.get('/:id', requireAuth, orderController.getOrder);
router.post('/', orderController.createOrder);
router.patch('/:id/status', requireAuth, requireRole(staffRoles), orderController.updateStatus);

export const ordersRouter = router;
