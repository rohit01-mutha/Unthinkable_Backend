import { Router } from 'express';
import { verifyAgent, listAllAgents } from '../controllers/adminController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { Role } from '@prisma/client';

const router = Router();

// List all agents (for verification panel)
router.get(
  '/agents',
  authenticateJWT as any,
  requireRole([Role.ADMIN]),
  listAllAgents as any
);

// Verify agent profile
router.post(
  '/agents/:profileId/verify',
  authenticateJWT as any,
  requireRole([Role.ADMIN]),
  verifyAgent as any
);

export default router;
