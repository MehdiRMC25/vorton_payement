import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { apiKeyAuth } from '../middleware/auth';
import * as paymentController from '../controllers/paymentController';

export const paymentRouter = Router();

paymentRouter.use(apiKeyAuth);

const createPaymentValidators = [
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
  body('currency').isLength({ min: 3, max: 3 }).withMessage('Currency must be 3 letters (e.g. AZN, USD)'),
  body('orderId').optional().isString().trim(),
  body('reference').optional().isString().trim(),
  body('customerId').optional().isString().trim(),
  body('customerEmail').optional().isEmail(),
  body('returnUrl').optional().isURL({ require_tld: false }),
  body('cancelUrl').optional().isURL({ require_tld: false }),
  body('language').optional().isIn(['en', 'az', 'ru']).withMessage('Use en, az, or ru'),
  body('metadata').optional().isObject(),
];

paymentRouter.post('/create', createPaymentValidators, (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  paymentController.create(req, res);
});

// Must be before /:paymentId — called after redirect from Kapital HPP with ID and STATUS.
paymentRouter.get(
  '/confirm',
  [
    query('ID').notEmpty().withMessage('ID (bank order id) required'),
    query('STATUS').notEmpty().withMessage('STATUS required'),
  ],
  (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    paymentController.confirm(req, res);
  }
);

paymentRouter.get('/:paymentId', paymentController.getStatus);
