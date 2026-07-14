import { Response } from 'express';
import { PrismaClient, Role, OrderStatus, PaymentType, OrderType } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { calculateCharge } from '../services/pricingService';
import { assignAgent, handleAgentAvailabilityRelease } from '../services/agentAssignmentService';
import { sendHistoryNotification } from '../services/notificationService';

const prisma = new PrismaClient();

// Shared status change logic incorporating strict transition rules
export const updateOrderStatusInternal = async (
  orderId: string,
  newStatus: OrderStatus,
  actorName: string,
  actorRole: Role,
  notes?: string,
  isOverride: boolean = false
): Promise<any> => {
  // Fetch order with assigned agent
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { assignedAgent: true },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  const currentStatus = order.status;

  // Run transition checks if not an admin override
  if (!isOverride) {
    if (currentStatus === newStatus) {
      return order; // No changes needed
    }

    // Terminal states cannot be changed
    const terminalStatuses: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.FAILED, OrderStatus.CANCELLED];
    if (terminalStatuses.includes(currentStatus)) {
      throw new Error(`Cannot transition order from terminal state: ${currentStatus}`);
    }

    // FAILED status is allowed from any non-terminal state
    if (newStatus !== OrderStatus.FAILED) {
      let valid = false;
      switch (currentStatus) {
        case OrderStatus.PLACED:
          valid = newStatus === OrderStatus.ASSIGNED;
          break;
        case OrderStatus.ASSIGNED:
          valid = newStatus === OrderStatus.PICKED_UP;
          break;
        case OrderStatus.PICKED_UP:
          valid = newStatus === OrderStatus.IN_TRANSIT;
          break;
        case OrderStatus.IN_TRANSIT:
          valid = newStatus === OrderStatus.OUT_FOR_DELIVERY;
          break;
        case OrderStatus.OUT_FOR_DELIVERY:
          valid = newStatus === OrderStatus.DELIVERED;
          break;
        default:
          valid = false;
      }

      if (!valid) {
        throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}`);
      }
    }
  }

  // Update status and append to history inside a transaction
  const updatedOrder = await prisma.$transaction(async (tx) => {
    const ord = await tx.order.update({
      where: { id: orderId },
      data: { status: newStatus },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        status: newStatus,
        actor: actorName,
        actorRole,
        notes: notes || (isOverride ? `Admin override status to ${newStatus}` : `Status updated to ${newStatus}`),
      },
    });

    return ord;
  });

  // Trigger customer notification
  sendHistoryNotification(
    orderId,
    newStatus,
    notes || (isOverride ? `Admin override status to ${newStatus}` : `Status updated to ${newStatus}`)
  );

  // Release agent availability on terminal status
  const terminalStatuses: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.FAILED, OrderStatus.CANCELLED];
  if (terminalStatuses.includes(newStatus) && order.assignedAgent) {
    await handleAgentAvailabilityRelease(order.assignedAgent.userId);
  }

  return updatedOrder;
};

// Get pricing quote (without creating an order)
export const getQuote = async (req: AuthenticatedRequest, res: Response) => {
  const {
    pickupPincode,
    dropPincode,
    length,
    breadth,
    height,
    actualWeight,
    orderType,
    paymentType,
  } = req.body;

  if (
    !pickupPincode ||
    !dropPincode ||
    length === undefined ||
    breadth === undefined ||
    height === undefined ||
    actualWeight === undefined ||
    !orderType ||
    !paymentType
  ) {
    return res.status(400).json({ error: 'All quoting parameters are required' });
  }

  try {
    const breakdown = await calculateCharge({
      pickupPincode,
      dropPincode,
      length: parseFloat(length),
      breadth: parseFloat(breadth),
      height: parseFloat(height),
      actualWeight: parseFloat(actualWeight),
      orderType: orderType as OrderType,
      paymentType: paymentType as PaymentType,
    });

    return res.status(200).json(breakdown);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Pricing quote failed' });
  }
};

// Confirm Customer Order (Self-serve)
export const confirmOrder = async (req: AuthenticatedRequest, res: Response) => {
  const {
    pickupPincode,
    dropPincode,
    length,
    breadth,
    height,
    actualWeight,
    orderType,
    paymentType,
  } = req.body;

  const customerId = req.user?.id;
  const userEmail = req.user?.email || 'Customer';

  if (!customerId) {
    return res.status(401).json({ error: 'Customer authentication context required' });
  }

  try {
    const pricing = await calculateCharge({
      pickupPincode,
      dropPincode,
      length: parseFloat(length),
      breadth: parseFloat(breadth),
      height: parseFloat(height),
      actualWeight: parseFloat(actualWeight),
      orderType: orderType as OrderType,
      paymentType: paymentType as PaymentType,
    });

    const userDetail = await prisma.user.findUnique({ where: { id: customerId } });
    const actorName = userDetail?.name || userEmail;

    const order = await prisma.$transaction(async (tx) => {
      const ord = await tx.order.create({
        data: {
          customerId,
          createdByUserId: customerId,
          pickupPincode,
          dropPincode,
          pickupZoneId: pricing.pickupZoneId,
          dropZoneId: pricing.dropZoneId,
          length: parseFloat(length),
          breadth: parseFloat(breadth),
          height: parseFloat(height),
          actualWeight: parseFloat(actualWeight),
          volumetricWeight: pricing.volumetricWeight,
          billableWeight: pricing.billableWeight,
          orderType: orderType as OrderType,
          paymentType: paymentType as PaymentType,
          charge: pricing.totalCharge,
          chargeIsEstimated: false,
          status: OrderStatus.PLACED,
          pendingAssignment: true,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: ord.id,
          status: OrderStatus.PLACED,
          actor: actorName,
          actorRole: Role.CUSTOMER,
          notes: 'Order created by customer (self-serve).',
        },
      });

      return ord;
    });

    // Trigger customer notification
    sendHistoryNotification(order.id, OrderStatus.PLACED, 'Order created by customer (self-serve).');

    // Trigger auto agent assignment
    await assignAgent(order.id);

    const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });

    return res.status(201).json({
      message: 'Order created successfully',
      order: finalOrder,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Order confirmation failed' });
  }
};

// Confirm Admin-assisted Order
export const adminConfirmOrder = async (req: AuthenticatedRequest, res: Response) => {
  const {
    customerId,
    pickupPincode,
    dropPincode,
    length,
    breadth,
    height,
    actualWeight,
    orderType,
    paymentType,
  } = req.body;

  const adminId = req.user?.id;
  const adminEmail = req.user?.email || 'Admin';

  if (!adminId) {
    return res.status(401).json({ error: 'Admin authentication context required' });
  }

  if (!customerId) {
    return res.status(400).json({ error: 'Customer ID is required for admin-assisted orders' });
  }

  try {
    const customer = await prisma.user.findUnique({ where: { id: customerId } });
    if (!customer) {
      return res.status(404).json({ error: 'Target customer account not found' });
    }

    const pricing = await calculateCharge({
      pickupPincode,
      dropPincode,
      length: parseFloat(length),
      breadth: parseFloat(breadth),
      height: parseFloat(height),
      actualWeight: parseFloat(actualWeight),
      orderType: orderType as OrderType,
      paymentType: paymentType as PaymentType,
    });

    const adminDetail = await prisma.user.findUnique({ where: { id: adminId } });
    const actorName = adminDetail?.name || adminEmail;

    const order = await prisma.$transaction(async (tx) => {
      const ord = await tx.order.create({
        data: {
          customerId,
          createdByUserId: adminId,
          pickupPincode,
          dropPincode,
          pickupZoneId: pricing.pickupZoneId,
          dropZoneId: pricing.dropZoneId,
          length: parseFloat(length),
          breadth: parseFloat(breadth),
          height: parseFloat(height),
          actualWeight: parseFloat(actualWeight),
          volumetricWeight: pricing.volumetricWeight,
          billableWeight: pricing.billableWeight,
          orderType: orderType as OrderType,
          paymentType: paymentType as PaymentType,
          charge: pricing.totalCharge,
          chargeIsEstimated: true,
          status: OrderStatus.PLACED,
          pendingAssignment: true,
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: ord.id,
          status: OrderStatus.PLACED,
          actor: actorName,
          actorRole: Role.ADMIN,
          notes: 'Order created by Admin on behalf of customer (estimated dimensions).',
        },
      });

      return ord;
    });

    // Trigger customer notification
    sendHistoryNotification(order.id, OrderStatus.PLACED, 'Order created by Admin on behalf of customer (estimated dimensions).');

    // Trigger auto agent assignment
    await assignAgent(order.id);

    const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });

    return res.status(201).json({
      message: 'Admin-assisted order created successfully',
      order: finalOrder,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Admin order confirmation failed' });
  }
};

// Update Order Status (complete / fail / in transit etc.) - Strict Gating
export const updateOrderStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const userId = req.user?.id;
  const userRole = req.user?.role;
  const userEmail = req.user?.email || 'User';

  if (!userId) {
    return res.status(401).json({ error: 'Authentication context required' });
  }

  if (!status) {
    return res.status(400).json({ error: 'Target order status is required' });
  }

  const validStatuses = Object.values(OrderStatus);
  if (!validStatuses.includes(status as any)) {
    return res.status(400).json({ error: `Invalid status. Choose from: ${validStatuses.join(', ')}` });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { assignedAgent: true },
    });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Role restrictions: Agents can only update orders assigned to them.
    if (userRole === Role.AGENT && (!order.assignedAgent || order.assignedAgent.userId !== userId)) {
      return res.status(403).json({ error: 'Forbidden: Agents can only update their assigned orders' });
    }

    const userDetail = await prisma.user.findUnique({ where: { id: userId } });
    const actorName = userDetail?.name || userEmail;

    // Weight & Dimension verification gate for estimated orders transitioning to PICKED_UP
    if (status === OrderStatus.PICKED_UP && order.chargeIsEstimated) {
      const { actualWeight, length, breadth, height } = req.body;
      if (
        actualWeight === undefined ||
        length === undefined ||
        breadth === undefined ||
        height === undefined
      ) {
        return res.status(400).json({
          error: 'Verification required: actualWeight, length, breadth, and height are required before picking up this estimated order.',
        });
      }

      const actWt = parseFloat(actualWeight);
      const len = parseFloat(length);
      const brd = parseFloat(breadth);
      const hgt = parseFloat(height);

      if (isNaN(actWt) || isNaN(len) || isNaN(brd) || isNaN(hgt) || actWt <= 0 || len <= 0 || brd <= 0 || hgt <= 0) {
        return res.status(400).json({ error: 'All weight and dimensions must be positive numbers.' });
      }

      // Re-run the calculateCharge() function
      const pricing = await calculateCharge({
        pickupPincode: order.pickupPincode,
        dropPincode: order.dropPincode,
        length: len,
        breadth: brd,
        height: hgt,
        actualWeight: actWt,
        orderType: order.orderType,
        paymentType: order.paymentType,
      });

      const oldCharge = order.charge;
      const newCharge = pricing.totalCharge;
      const chargeChanged = Math.abs(oldCharge - newCharge) > 0.001;

      await prisma.$transaction(async (tx) => {
        // Update dimensions and set chargeIsEstimated to false
        await tx.order.update({
          where: { id },
          data: {
            actualWeight: actWt,
            length: len,
            breadth: brd,
            height: hgt,
            volumetricWeight: pricing.volumetricWeight,
            billableWeight: pricing.billableWeight,
            charge: newCharge,
            chargeIsEstimated: false,
          },
        });

        // Log Weight verification history entry
        const historyNotes = chargeChanged
          ? `Weight verified at pickup — charge revised ₹${oldCharge.toFixed(2)} -> ₹${newCharge.toFixed(2)}`
          : 'Weight verified at pickup — matches estimate';

        await tx.orderStatusHistory.create({
          data: {
            orderId: id,
            status: OrderStatus.ASSIGNED,
            actor: actorName,
            actorRole: userRole as Role,
            notes: historyNotes,
          },
        });
      });

      const historyNotes = chargeChanged
        ? `Weight verified at pickup — charge revised ₹${oldCharge.toFixed(2)} -> ₹${newCharge.toFixed(2)}`
        : 'Weight verified at pickup — matches estimate';

      sendHistoryNotification(id, OrderStatus.ASSIGNED, historyNotes);

      if (chargeChanged) {
        const customerUser = await prisma.user.findUnique({ where: { id: order.customerId } });
        console.log(`[Notification Stub] To: ${customerUser?.email || 'customer@test.com'} | Subject: Shipping Charge Revised | Body: Dear Customer, the charge for shipment ${id.substring(0,8)} has been revised from ₹${oldCharge.toFixed(2)} to ₹${newCharge.toFixed(2)} based on measured dimensions (${len}x${brd}x${hgt} cm, ${actWt} Kg).`);
      }
    }

    // Use shared state transition helper
    const updatedOrder = await updateOrderStatusInternal(
      id,
      status as OrderStatus,
      actorName,
      userRole as Role,
      notes,
      false // isOverride = false
    );

    return res.status(200).json({
      message: `Status updated successfully to ${status}`,
      order: updatedOrder,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Status update failed' });
  }
};

// Admin Manual Force Override Status
export const adminOverrideOrderStatus = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const adminId = req.user?.id;

  if (!adminId) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  if (!status) {
    return res.status(400).json({ error: 'Target status is required' });
  }

  const validStatuses = Object.values(OrderStatus);
  if (!validStatuses.includes(status as any)) {
    return res.status(400).json({ error: `Invalid status. Choose from: ${validStatuses.join(', ')}` });
  }

  try {
    const updatedOrder = await updateOrderStatusInternal(
      id,
      status as OrderStatus,
      'admin (override)',
      Role.ADMIN,
      notes || 'Force transition by administrator',
      true // isOverride = true
    );

    return res.status(200).json({
      message: `Admin override status updated to ${status}`,
      order: updatedOrder,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Override status update failed' });
  }
};

// Admin Manual Override Assignment
export const manualAssignAgent = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { agentId } = req.body;
  const adminId = req.user?.id;
  const adminEmail = req.user?.email || 'Admin';

  if (!adminId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!agentId) {
    return res.status(400).json({ error: 'Target agent ID is required for assignment' });
  }

  try {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const agentProfile = await prisma.agentProfile.findUnique({
      where: { userId: agentId },
      include: { user: true },
    });

    if (!agentProfile || agentProfile.verificationStatus !== 'APPROVED') {
      return res.status(400).json({ error: 'Target agent is either not found or not approved' });
    }

    const adminDetail = await prisma.user.findUnique({ where: { id: adminId } });
    const actorName = adminDetail?.name || adminEmail;

    const updatedOrder = await prisma.$transaction(async (tx) => {
      // 1. Release previous agent's availability if there was one
      if (order.assignedAgentId) {
        await tx.agentProfile.update({
          where: { id: order.assignedAgentId },
          data: { availability: true },
        });
      }

      // 2. Update order status and assignment details
      const ord = await tx.order.update({
        where: { id },
        data: {
          assignedAgentId: agentProfile.id,
          status: OrderStatus.ASSIGNED,
          pendingAssignment: false,
        },
      });

      // 3. Mark newly assigned agent as busy
      await tx.agentProfile.update({
        where: { id: agentProfile.id },
        data: { availability: false },
      });

      // 4. Log audit log in history
      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: OrderStatus.ASSIGNED,
          actor: actorName,
          actorRole: Role.ADMIN,
          notes: `Manually assigned by admin. Agent: ${agentProfile.user.name}`,
        },
      });

      return ord;
    });

    return res.status(200).json({
      message: 'Agent assigned manually',
      order: updatedOrder,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Manual assignment failed' });
  }
};

// List user orders depending on their role
export const listUserOrders = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    let orders;

    if (role === Role.ADMIN) {
      orders = await prisma.order.findMany({
        include: {
          customer: { select: { name: true, email: true, phone: true } },
          creator: { select: { name: true, role: true } },
          pickupZone: { select: { name: true } },
          dropZone: { select: { name: true } },
          statusHistory: { orderBy: { timestamp: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
      });
    } else if (role === Role.AGENT) {
      orders = await prisma.order.findMany({
        where: {
          assignedAgent: {
            userId: userId,
          },
        },
        include: {
          customer: { select: { name: true, email: true, phone: true } },
          creator: { select: { name: true, role: true } },
          pickupZone: { select: { name: true } },
          dropZone: { select: { name: true } },
          statusHistory: { orderBy: { timestamp: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      orders = await prisma.order.findMany({
        where: { customerId: userId },
        include: {
          creator: { select: { name: true, role: true } },
          pickupZone: { select: { name: true } },
          dropZone: { select: { name: true } },
          statusHistory: { orderBy: { timestamp: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    return res.status(200).json(orders);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to list orders' });
  }
};

// List all customers (Helper route for Admin order creation)
export const listCustomers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const customers = await prisma.user.findMany({
      where: { role: Role.CUSTOMER },
      select: { id: true, name: true, email: true, phone: true },
      orderBy: { name: 'asc' },
    });
    return res.status(200).json(customers);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch customers' });
  }
};

// List approved agents (Helper route for Admin manual assignment override)
export const listApprovedAgents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const agents = await prisma.agentProfile.findMany({
      where: { verificationStatus: 'APPROVED' },
      include: {
        user: { select: { name: true, email: true, phone: true } },
        currentZone: { select: { name: true } },
      },
      orderBy: { user: { name: 'asc' } },
    });
    return res.status(200).json(agents);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to list agents' });
  }
};

// Reschedule Order (Customer only, allowed when status is FAILED, up to 3 times)
export const rescheduleOrder = async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { deliveryDate } = req.body;
  const userId = req.user?.id;
  const userRole = req.user?.role;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!deliveryDate) {
    return res.status(400).json({ error: 'A new delivery date is required to reschedule.' });
  }

  const parsedDate = new Date(deliveryDate);
  if (isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Invalid delivery date format.' });
  }

  // Ensure target date is in the future
  if (parsedDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'Delivery date must be in the future.' });
  }

  try {
    const order = await prisma.order.findUnique({
      where: { id },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Role restrictions: Customer only, and must own the order
    if (userRole !== Role.CUSTOMER || order.customerId !== userId) {
      return res.status(403).json({ error: 'Forbidden: Only the customer who placed the order can reschedule it.' });
    }

    // Must be in Failed status
    if (order.status !== OrderStatus.FAILED) {
      return res.status(400).json({ error: 'Only failed deliveries can be rescheduled.' });
    }

    // Max 3 reschedule attempts
    if (order.rescheduleCount >= 3) {
      return res.status(400).json({ error: 'Maximum reschedule attempts (3) exceeded for this order.' });
    }

    const userDetail = await prisma.user.findUnique({ where: { id: userId } });
    const actorName = userDetail?.name || req.user?.email || 'Customer';

    const nextCount = order.rescheduleCount + 1;
    const dateString = parsedDate.toLocaleDateString();

    const updated = await prisma.$transaction(async (tx) => {
      // Update order status back to PLACED, clear agent, update rescheduleCount & deliveryDate
      const ord = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.PLACED,
          assignedAgentId: null,
          pendingAssignment: true,
          rescheduleCount: nextCount,
          deliveryDate: parsedDate,
        },
      });

      // Log in OrderStatusHistory
      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: OrderStatus.PLACED,
          actor: actorName,
          actorRole: Role.CUSTOMER,
          notes: `Order rescheduled for delivery on ${dateString}. Reschedule attempt #${nextCount}`,
        },
      });

      return ord;
    });

    // Trigger customer notification
    sendHistoryNotification(updated.id, OrderStatus.PLACED, `Order rescheduled for delivery on ${dateString}. Reschedule attempt #${nextCount}`);

    // Immediately trigger agent assignment search
    await assignAgent(updated.id);

    const finalOrder = await prisma.order.findUnique({
      where: { id: updated.id },
      include: {
        customer: { select: { name: true, email: true } },
        creator: { select: { name: true, role: true } },
        pickupZone: { select: { name: true } },
        dropZone: { select: { name: true } },
        assignedAgent: { include: { user: { select: { name: true } } } },
        statusHistory: true,
      },
    });

    return res.status(200).json({
      message: 'Order rescheduled successfully',
      order: finalOrder,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Rescheduling failed' });
  }
};
