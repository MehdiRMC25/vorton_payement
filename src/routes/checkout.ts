import { Router } from 'express';
import { requireAuth } from '../middleware/jwtAuth';
import * as checkoutController from '../controllers/checkoutController';

export const checkoutRouter = Router();

checkoutRouter.post('/preview', requireAuth, checkoutController.previewCheckout);
