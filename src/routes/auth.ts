import { Router } from 'express';
import { signup, login, me } from '../controllers/authController';
import { requireAuth } from '../middleware/jwtAuth';
import {
  patchProfile,
  requestEmailChangeCode,
  confirmEmailChange,
  appendCheckoutDelivery,
} from '../controllers/authProfileController';
import * as cartController from '../controllers/cartController';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', me);

router.patch('/profile', requireAuth, patchProfile);
router.post('/profile/email/request-code', requireAuth, requestEmailChangeCode);
router.post('/profile/email/confirm', requireAuth, confirmEmailChange);
router.post('/checkout-delivery', requireAuth, appendCheckoutDelivery);

/** Server-side cart (PostgreSQL cart_items) — requires Bearer JWT */
router.get('/cart', requireAuth, cartController.getCart);
router.put('/cart/items', requireAuth, cartController.putCartItem);
router.delete('/cart/items', requireAuth, cartController.removeCartItem);
router.post('/cart/sync', requireAuth, cartController.syncCart);
router.delete('/cart', requireAuth, cartController.deleteCartAll);

export const authRouter = router;



