import { Router } from 'express';
import {
  getQuote,
  confirmOrder,
  adminConfirmOrder,
  listUserOrders,
  listCustomers,
  listApprovedAgents,
  updateOrderStatus,
  adminOverrideOrderStatus,
  manualAssignAgent,
  rescheduleOrder,
} from '../controllers/orderController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { Role } from '@prisma/client';

const router = Router();

// Quote is accessible to customers and admins
router.post('/quote', authenticateJWT as any, getQuote as any);

// Customer self-serve confirm
router.post('/confirm', authenticateJWT as any, requireRole([Role.CUSTOMER]), confirmOrder as any);

// Admin-assisted confirm
router.post('/admin/confirm', authenticateJWT as any, requireRole([Role.ADMIN]), adminConfirmOrder as any);

// List orders
router.get('/', authenticateJWT as any, listUserOrders as any);

// Helper for admin UI to list customers
router.get('/customers', authenticateJWT as any, requireRole([Role.ADMIN]), listCustomers as any);

// Helper for admin UI to list approved agents
router.get('/agents', authenticateJWT as any, requireRole([Role.ADMIN]), listApprovedAgents as any);

// Update status (accessible to agent and admin; validates valid lifecycle transitions)
router.patch('/:id/status', authenticateJWT as any, updateOrderStatus as any);

// Admin manual status override (bypasses valid transitions)
router.patch('/:id/status/override', authenticateJWT as any, requireRole([Role.ADMIN]), adminOverrideOrderStatus as any);

// Manual agent assignment override (admin only)
router.patch('/:id/assign-agent', authenticateJWT as any, requireRole([Role.ADMIN]), manualAssignAgent as any);

// Reschedule order (customer only)
router.post('/:id/reschedule', authenticateJWT as any, requireRole([Role.CUSTOMER]), rescheduleOrder as any);

export default router;
