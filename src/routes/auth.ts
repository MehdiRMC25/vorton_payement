import { Router } from 'express';
import { signup, login, me } from '../controllers/authController';
import { requireAuth } from '../middleware/jwtAuth';
import {
  patchProfile,
  requestEmailChangeCode,
  confirmEmailChange,
  appendCheckoutDelivery,
} from '../controllers/authProfileController';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', me);

router.patch('/profile', requireAuth, patchProfile);
router.post('/profile/email/request-code', requireAuth, requestEmailChangeCode);
router.post('/profile/email/confirm', requireAuth, confirmEmailChange);
router.post('/checkout-delivery', requireAuth, appendCheckoutDelivery);

export const authRouter = router;



