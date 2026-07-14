import { Router } from 'express';
import {
  customerSignup,
  agentSignup,
  adminSignup,
  login,
  proposeAdmin,
  approveAdmin,
  listAdminRequests,
} from '../controllers/authController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { Role } from '@prisma/client';

const router = Router();

// Public onboarding
router.post('/signup/customer', customerSignup);
router.post('/signup/agent', agentSignup);
router.post('/signup/admin', adminSignup);
router.post('/login', login);

// Admin maker-checker (maker-checker operations require ADMIN role)
router.post(
  '/admin/propose',
  authenticateJWT as any,
  requireRole([Role.ADMIN]),
  proposeAdmin as any
);
router.post(
  '/admin/approve',
  authenticateJWT as any,
  requireRole([Role.ADMIN]),
  approveAdmin as any
);
router.get(
  '/admin/requests',
  authenticateJWT as any,
  requireRole([Role.ADMIN]),
  listAdminRequests as any
);

export default router;
