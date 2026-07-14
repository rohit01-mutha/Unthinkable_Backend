import request from 'supertest';
import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import app from '../src/index';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

describe('Mission 6: Agent Auto-Assignment & Fallbacks Integration Tests', () => {
  jest.setTimeout(30000);

  let adminToken: string;
  let customerToken: string;
  let customerId: string;

  let northZoneId: string;
  let southZoneId: string;

  let agentAId: string;
  let agentAProfileId: string;
  let agentBId: string;
  let agentBProfileId: string;

  beforeAll(async () => {
    // 1. Clean the database
    await prisma.agentVerificationLog.deleteMany({});
    await prisma.agentProfile.deleteMany({});
    await prisma.orderStatusHistory.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.adminAccountRequest.deleteMany({});
    await prisma.zoneArea.deleteMany({});
    await prisma.zone.deleteMany({});
    await prisma.rateCard.deleteMany({});
    await prisma.user.deleteMany({});

    // 2. Create Zones and pincodes
    const nZone = await prisma.zone.create({ data: { name: 'North Zone' } });
    const sZone = await prisma.zone.create({ data: { name: 'South Zone' } });
    northZoneId = nZone.id;
    southZoneId = sZone.id;

    await prisma.zoneArea.create({ data: { pincode: '110001', zoneId: northZoneId } });
    await prisma.zoneArea.create({ data: { pincode: '110002', zoneId: northZoneId } });
    await prisma.zoneArea.create({ data: { pincode: '560001', zoneId: southZoneId } });

    // 3. Create B2C / B2B Rate cards
    await prisma.rateCard.create({
      data: {
        orderType: OrderType.B2B,
        intraZoneRate: 50.0,
        interZoneRate: 100.0,
        codSurcharge: 15.0,
      },
    });
    await prisma.rateCard.create({
      data: {
        orderType: OrderType.B2C,
        intraZoneRate: 40.0,
        interZoneRate: 80.0,
        codSurcharge: 10.0,
      },
    });

    // 4. Create Users (Admin, Customer, Agents)
    const admin = await prisma.user.create({
      data: {
        email: 'assign_admin@test.com',
        name: 'System Admin',
        phone: '1111111111',
        passwordHash: 'dummy',
        role: Role.ADMIN,
      },
    });
    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET);

    const customer = await prisma.user.create({
      data: {
        email: 'assign_customer@test.com',
        name: 'John Customer',
        phone: '2222222222',
        passwordHash: 'dummy',
        role: Role.CUSTOMER,
      },
    });
    customerId = customer.id;
    customerToken = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, JWT_SECRET);

    // Create Agent A (North Zone)
    const userA = await prisma.user.create({
      data: {
        email: 'agent_a@test.com',
        name: 'Agent Alpha',
        phone: '3333333333',
        passwordHash: 'dummy',
        role: Role.AGENT,
      },
    });
    agentAId = userA.id;
    const profileA = await prisma.agentProfile.create({
      data: {
        userId: agentAId,
        vehicleType: 'BIKE',
        currentZoneId: northZoneId,
        verificationStatus: 'APPROVED',
        availability: true,
        kycDocUrl: 'https://kyc.test.com/docA.pdf',
      },
    });
    agentAProfileId = profileA.id;

    // Create Agent B (North Zone)
    const userB = await prisma.user.create({
      data: {
        email: 'agent_b@test.com',
        name: 'Agent Beta',
        phone: '4444444444',
        passwordHash: 'dummy',
        role: Role.AGENT,
      },
    });
    agentBId = userB.id;
    const profileB = await prisma.agentProfile.create({
      data: {
        userId: agentBId,
        vehicleType: 'BIKE',
        currentZoneId: northZoneId,
        verificationStatus: 'APPROVED',
        availability: true,
        kycDocUrl: 'https://kyc.test.com/docB.pdf',
      },
    });
    agentBProfileId = profileB.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test 1: Auto assignment matching
  test('1. Auto-assigns the created order to an approved available agent in the zone', async () => {
    // Both Agent A and Agent B are free (active = 0).
    const res = await request(app)
      .post('/api/orders/confirm')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        pickupPincode: '110001',
        dropPincode: '110002',
        length: 10,
        breadth: 10,
        height: 10,
        actualWeight: 1.0,
        orderType: OrderType.B2C,
        paymentType: PaymentType.PREPAID,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe(OrderStatus.ASSIGNED);
    expect(res.body.order.pendingAssignment).toBe(false);
    expect(res.body.order.assignedAgentId).toBeDefined();

    // Verify chosen agent availability flips to false (checking by AgentProfile.id)
    const assignedAgentId = res.body.order.assignedAgentId;
    const profile = await prisma.agentProfile.findUnique({
      where: { id: assignedAgentId },
    });
    expect(profile?.availability).toBe(false);

    // Verify history audit logs
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: res.body.order.id, status: OrderStatus.ASSIGNED },
    });
    expect(history.length).toBe(1);
    expect(history[0].actor).toBe('system');
  });

  // Test 2: Load Balancing (picks agent with lowest load)
  test('2. Rank-sorts and load-balances candidate agents by fewest active shipments', async () => {
    // At this point, one agent is busy (assigned 1 order). The other agent is free.
    // Let's identify the free agent profile.
    const profiles = await prisma.agentProfile.findMany({
      where: { currentZoneId: northZoneId },
    });
    const freeAgentProfile = profiles.find((p) => p.availability === true);
    const busyAgentProfile = profiles.find((p) => p.availability === false);

    expect(freeAgentProfile).toBeDefined();
    expect(busyAgentProfile).toBeDefined();

    // Place a second order. It should go to the free agent.
    const res = await request(app)
      .post('/api/orders/confirm')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        pickupPincode: '110001',
        dropPincode: '110002',
        length: 10,
        breadth: 10,
        height: 10,
        actualWeight: 1.0,
        orderType: OrderType.B2C,
        paymentType: PaymentType.PREPAID,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.assignedAgentId).toBe(freeAgentProfile?.id);

    // Now, both agents should be busy (availability = false).
    const updatedProfiles = await prisma.agentProfile.findMany({
      where: { currentZoneId: northZoneId },
    });
    expect(updatedProfiles.every((p) => p.availability === false)).toBe(true);
  });

  // Test 3: Exhaustion Fallback (pending assignment)
  test('3. Flags pendingAssignment = true when all zone agents are exhausted', async () => {
    // Both agents are currently busy. Place 3rd order.
    const res = await request(app)
      .post('/api/orders/confirm')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        pickupPincode: '110001',
        dropPincode: '110002',
        length: 10,
        breadth: 10,
        height: 10,
        actualWeight: 1.0,
        orderType: OrderType.B2C,
        paymentType: PaymentType.PREPAID,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe(OrderStatus.PLACED); // stays placed
    expect(res.body.order.pendingAssignment).toBe(true);
    expect(res.body.order.assignedAgentId).toBeNull();

    // Verify history audit logs
    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: res.body.order.id, notes: 'Awaiting agent — none free in zone' },
    });
    expect(history).toBeDefined();
  });

  // Test 4: Complete delivery release and retry hook
  test('4. Completing/failing a delivery frees the agent and immediately triggers pending assignment retry', async () => {
    // Find one of the busy orders assigned to Agent Alpha (AgentProfile.id = agentAProfileId)
    const activeOrder = await prisma.order.findFirst({
      where: { assignedAgentId: agentAProfileId, status: OrderStatus.ASSIGNED },
    });
    expect(activeOrder).toBeDefined();

    // Find the pending assignment order (which is waiting in North Zone)
    const pendingOrder = await prisma.order.findFirst({
      where: { pickupZoneId: northZoneId, pendingAssignment: true },
    });
    expect(pendingOrder).toBeDefined();

    const agentToken = jwt.sign({ id: agentAId, email: 'agent_a@test.com', role: Role.AGENT }, JWT_SECRET);

    // Call PATCH /orders/:id/status to mark as FAILED
    const statusRes = await request(app)
      .patch(`/api/orders/${activeOrder?.id}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        status: OrderStatus.FAILED,
        notes: 'Delivery completed successfully by agent.',
      });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.order.status).toBe(OrderStatus.FAILED);

    // Check if the pending order has now been auto-assigned to Agent Alpha!
    const recheckedPendingOrder = await prisma.order.findUnique({
      where: { id: pendingOrder?.id },
    });

    expect(recheckedPendingOrder?.status).toBe(OrderStatus.ASSIGNED);
    expect(recheckedPendingOrder?.pendingAssignment).toBe(false);
    expect(recheckedPendingOrder?.assignedAgentId).toBe(agentAProfileId);

    // Verify agent is busy again (availability = false) since they took the new order
    const agentProfile = await prisma.agentProfile.findUnique({
      where: { id: agentAProfileId },
    });
    expect(agentProfile?.availability).toBe(false);
  });

  // Test 5: Manual Override by Admin
  test('5. Admin manual override bypasses routing constraints and assigns specific agent', async () => {
    // Find the assigned order of Agent Alpha (AgentProfile.id = agentAProfileId)
    const activeOrder = await prisma.order.findFirst({
      where: { assignedAgentId: agentAProfileId, status: OrderStatus.ASSIGNED },
    });
    expect(activeOrder).toBeDefined();

    // Admin manually re-assigns this order to Agent Beta (agentBId)
    const overrideRes = await request(app)
      .patch(`/api/orders/${activeOrder?.id}/assign-agent`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ agentId: agentBId }); // Endpoint receives agent's user ID

    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.order.assignedAgentId).toBe(agentBProfileId);
    expect(overrideRes.body.order.status).toBe(OrderStatus.ASSIGNED);
    expect(overrideRes.body.order.pendingAssignment).toBe(false);

    // Verify old agent A availability becomes true
    const profileA = await prisma.agentProfile.findUnique({
      where: { id: agentAProfileId },
    });
    expect(profileA?.availability).toBe(true);

    // Verify new agent B availability becomes false
    const profileB = await prisma.agentProfile.findUnique({
      where: { id: agentBProfileId },
    });
    expect(profileB?.availability).toBe(false);

    // Verify history audit logs
    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: activeOrder?.id, notes: { contains: 'Manually assigned by admin' } },
    });
    expect(history).toBeDefined();
  });
});
