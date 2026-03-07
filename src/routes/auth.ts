import { Router } from 'express';
import { signup, login, me } from '../controllers/authController';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', me);

export const authRouter = router;



