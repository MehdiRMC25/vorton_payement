import { Router } from 'express';
import { signup, login, me, requestAccountDeletion, cancelAccountDeletion } from '../controllers/authController';
import { requireAuth, requireActiveAccount } from '../middleware/jwtAuth';
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
router.post('/account/request-deletion', requireAuth, requireActiveAccount, requestAccountDeletion);
router.post('/account/cancel-deletion', requireAuth, cancelAccountDeletion);

router.patch('/profile', requireAuth, requireActiveAccount, patchProfile);
router.post('/profile/email/request-code', requireAuth, requireActiveAccount, requestEmailChangeCode);
router.post('/profile/email/confirm', requireAuth, requireActiveAccount, confirmEmailChange);
router.post('/checkout-delivery', requireAuth, requireActiveAccount, appendCheckoutDelivery);

/** Server-side cart (PostgreSQL cart_items) — requires Bearer JWT */
router.get('/cart', requireAuth, requireActiveAccount, cartController.getCart);
router.put('/cart/items', requireAuth, requireActiveAccount, cartController.putCartItem);
router.delete('/cart/items', requireAuth, requireActiveAccount, cartController.removeCartItem);
router.post('/cart/sync', requireAuth, requireActiveAccount, cartController.syncCart);
router.delete('/cart', requireAuth, requireActiveAccount, cartController.deleteCartAll);

export const authRouter = router;



