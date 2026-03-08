import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/jwtAuth';
import * as orderController from '../controllers/orderController';

const router = Router();

router.get('/', requireAuth, requireRole(['employee', 'manager']), orderController.listOrders);
router.get('/stats', requireAuth, requireRole(['manager']), orderController.orderStats);
router.get('/customer/:customerId', requireAuth, orderController.getOrdersByCustomer);
router.get('/:id', requireAuth, orderController.getOrder);
router.post('/', orderController.createOrder);
router.patch('/:id/status', requireAuth, requireRole(['employee', 'manager']), orderController.updateStatus);

export const ordersRouter = router;
