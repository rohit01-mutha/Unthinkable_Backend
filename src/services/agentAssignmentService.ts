import { PrismaClient, OrderStatus, Role } from '@prisma/client';
import { sendHistoryNotification } from './notificationService';

const prisma = new PrismaClient();

/**
 * Automates assignment of a delivery agent to an order.
 * Picks approved, active agents in the pickup zone with the lowest current workload.
 */
export const assignAgent = async (orderId: string, txClient?: any): Promise<any> => {
  const client = txClient || prisma;

  // 1. Fetch order details
  const order = await client.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  // Bypasses if order is already assigned or in transit/terminal states
  if (order.status !== OrderStatus.PLACED || order.assignedAgentId) {
    return null;
  }

  // 2. Fetch approved, available agents in the order's pickup zone (currentZoneId)
  const candidates = await client.agentProfile.findMany({
    where: {
      currentZoneId: order.pickupZoneId,
      availability: true,
      verificationStatus: 'APPROVED',
    },
    include: {
      user: true,
    },
  });

  // 3. Fallback if no agents are available
  if (candidates.length === 0) {
    await client.order.update({
      where: { id: orderId },
      data: {
        pendingAssignment: true,
        status: OrderStatus.PLACED,
      },
    });

    const existingAwaitingLog = await client.orderStatusHistory.findFirst({
      where: {
        orderId,
        status: OrderStatus.PLACED,
        notes: 'Awaiting agent — none free in zone',
      },
    });

    if (!existingAwaitingLog) {
      await client.orderStatusHistory.create({
        data: {
          orderId,
          status: OrderStatus.PLACED,
          actor: 'system',
          actorRole: Role.ADMIN,
          notes: 'Awaiting agent — none free in zone',
        },
      });
    }

    return null;
  }

  // 4. Load-rank candidates based on active (non-terminal) assigned shipments
  const rankedCandidates = await Promise.all(
    candidates.map(async (agent: any) => {
      const activeCount = await client.order.count({
        where: {
          assignedAgent: {
            userId: agent.userId,
          },
          status: {
            notIn: [OrderStatus.DELIVERED, OrderStatus.FAILED, OrderStatus.CANCELLED],
          },
        },
      });
      return { agent, activeCount };
    })
  );

  // Sort by lowest workload
  rankedCandidates.sort((a: any, b: any) => a.activeCount - b.activeCount);
  const chosenAgent = rankedCandidates[0].agent;

  // 5. Update assignment parameters inside DB (assigning AgentProfile.id to assignedAgentId)
  await client.order.update({
    where: { id: orderId },
    data: {
      assignedAgentId: chosenAgent.id,
      status: OrderStatus.ASSIGNED,
      pendingAssignment: false,
    },
  });

  // Toggle agent busy status
  await client.agentProfile.update({
    where: { id: chosenAgent.id },
    data: { availability: false },
  });

  // Log audit history trail
  await client.orderStatusHistory.create({
    data: {
      orderId,
      status: OrderStatus.ASSIGNED,
      actor: 'system',
      actorRole: Role.ADMIN,
      notes: `System auto-assigned agent: ${chosenAgent.user.name}`,
    },
  });

  // Trigger customer notification
  sendHistoryNotification(orderId, OrderStatus.ASSIGNED, `System auto-assigned agent: ${chosenAgent.user.name}`);

  return chosenAgent;
};

/**
 * Triggered when an agent becomes free (completed/failed delivery).
 * Attempts to re-assign the agent to the oldest pending order in their zone.
 */
export const handleAgentAvailabilityRelease = async (agentUserId: string, txClient?: any): Promise<void> => {
  const client = txClient || prisma;

  // Retrieve agent profile details
  const agentProfile = await client.agentProfile.findUnique({
    where: { userId: agentUserId },
  });

  if (!agentProfile || agentProfile.verificationStatus !== 'APPROVED') {
    return;
  }

  // 1. Mark agent as available
  await client.agentProfile.update({
    where: { userId: agentUserId },
    data: { availability: true },
  });

  // 2. Fetch the oldest pending assignment order in their zone (currentZoneId)
  const oldestPendingOrder = await client.order.findFirst({
    where: {
      pickupZoneId: agentProfile.currentZoneId,
      pendingAssignment: true,
      status: OrderStatus.PLACED,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  // 3. Immediately trigger assignment attempt
  if (oldestPendingOrder) {
    await assignAgent(oldestPendingOrder.id, client);
  }
};
