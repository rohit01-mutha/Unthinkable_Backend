import { Router } from 'express';
import { upsertRateCard, listRateCards } from '../controllers/rateCardController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { Role } from '@prisma/client';

const router = Router();

router.post('/', authenticateJWT as any, requireRole([Role.ADMIN]), upsertRateCard as any);
router.get('/', authenticateJWT as any, requireRole([Role.ADMIN]), listRateCards as any);

export default router;
