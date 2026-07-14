import { Router } from 'express';
import {
  createZone,
  listZones,
  deleteZone,
  createZoneArea,
  listZoneAreas,
  deleteZoneArea,
} from '../controllers/zoneController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { Role } from '@prisma/client';

const router = Router();

// Zone endpoints (Admin restricted)
router.post('/', authenticateJWT as any, requireRole([Role.ADMIN]), createZone as any);
router.get('/', authenticateJWT as any, requireRole([Role.ADMIN]), listZones as any);
router.delete('/:id', authenticateJWT as any, requireRole([Role.ADMIN]), deleteZone as any);

// Zone Area mapping endpoints (Admin restricted)
router.post('/areas', authenticateJWT as any, requireRole([Role.ADMIN]), createZoneArea as any);
router.get('/areas', authenticateJWT as any, requireRole([Role.ADMIN]), listZoneAreas as any);
router.delete('/areas/:pincode', authenticateJWT as any, requireRole([Role.ADMIN]), deleteZoneArea as any);

export default router;
