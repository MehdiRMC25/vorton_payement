import { Router } from 'express';
import { apiKeyAuth } from '../middleware/auth';
import * as testPaymentController from '../controllers/testPaymentController';

export const testPaymentsRouter = Router();

// Keep protected and only for test env.
testPaymentsRouter.use(apiKeyAuth);
testPaymentsRouter.post('/force-success', testPaymentController.forceSuccess);