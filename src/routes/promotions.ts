import { Router } from 'express';
import * as promotionsController from '../controllers/promotionsController';

export const promotionsRouter = Router();

promotionsRouter.get('/active', promotionsController.getActiveCampaign);