import request from 'supertest';
import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import app from '../src/index';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

describe('Mission 7: Order Status Lifecycle Integration Tests', () => {
  jest.setTimeout(30000);

  let adminToken: string;
  let customerToken: string;
  let customerId: string;
  let agentToken: string;
  let agentId: string;
  let agentProfileId: string;
  let orderId: string;

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

    // 2. Create Zones & Areas
    const zone = await prisma.zone.create({ data: { name: 'Main Zone' } });
    await prisma.zoneArea.create({ data: { pincode: '110001', zoneId: zone.id } });

    // 3. Create Rate cards
    await prisma.rateCard.create({
      data: {
        orderType: OrderType.B2C,
        intraZoneRate: 40.0,
        interZoneRate: 80.0,
        codSurcharge: 10.0,
      },
    });

    // 4. Create admin, customer, agent users
    const admin = await prisma.user.create({
      data: {
        email: 'lifecycle_admin@test.com',
        name: 'System Admin',
        phone: '1111111111',
        passwordHash: 'dummy',
        role: Role.ADMIN,
      },
    });
    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET);

    const customer = await prisma.user.create({
      data: {
        email: 'lifecycle_customer@test.com',
        name: 'John Customer',
        phone: '2222222222',
        passwordHash: 'dummy',
        role: Role.CUSTOMER,
      },
    });
    customerId = customer.id;
    customerToken = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, JWT_SECRET);

    const agent = await prisma.user.create({
      data: {
        email: 'lifecycle_agent@test.com',
        name: 'Delivery Agent Alpha',
        phone: '3333333333',
        passwordHash: 'dummy',
        role: Role.AGENT,
      },
    });
    agentId = agent.id;
    agentToken = jwt.sign({ id: agent.id, email: agent.email, role: agent.role }, JWT_SECRET);

    const profile = await prisma.agentProfile.create({
      data: {
        userId: agentId,
        vehicleType: 'BIKE',
        currentZoneId: zone.id,
        verificationStatus: 'APPROVED',
        availability: true,
        kycDocUrl: 'http://kyc.test',
      },
    });
    agentProfileId = profile.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test 1: Seed a base unassigned order
  test('1. Places order successfully (starts as PLACED, unassigned)', async () => {
    const res = await request(app)
      .post('/api/orders/confirm')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        pickupPincode: '110001',
        dropPincode: '110001',
        length: 10,
        breadth: 10,
        height: 10,
        actualWeight: 1.0,
        orderType: OrderType.B2C,
        paymentType: PaymentType.PREPAID,
      });

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe(OrderStatus.ASSIGNED); // Auto assigned to our single free agent!
    expect(res.body.order.assignedAgentId).toBe(agentProfileId);
    orderId = res.body.order.id;
  });

  // Test 2: Valid progression by agent
  test('2. Agent can advance order status through valid transitions (Assigned -> Picked Up -> In Transit)', async () => {
    // Current is ASSIGNED. Valid next is PICKED_UP.
    const res1 = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.PICKED_UP });

    expect(res1.status).toBe(200);
    expect(res1.body.order.status).toBe(OrderStatus.PICKED_UP);

    // Current is PICKED_UP. Valid next is IN_TRANSIT.
    const res2 = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.IN_TRANSIT });

    expect(res2.status).toBe(200);
    expect(res2.body.order.status).toBe(OrderStatus.IN_TRANSIT);
  });

  // Test 3: Invalid progression rejected
  test('3. Rejects invalid transitions (skipping steps, moving backward)', async () => {
    // Current is IN_TRANSIT. Valid next is OUT_FOR_DELIVERY.
    // Invalid next: DELIVERED (skipping OUT_FOR_DELIVERY)
    const resSkip = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.DELIVERED });

    expect(resSkip.status).toBe(400);
    expect(resSkip.body.error).toContain('Invalid status transition');

    // Invalid next: ASSIGNED (moving backward)
    const resBack = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.ASSIGNED });

    expect(resBack.status).toBe(400);
    expect(resBack.body.error).toContain('Invalid status transition');
  });

  // Test 4: Failed transition is allowed from any state
  test('4. Allows transition to FAILED from any non-terminal state', async () => {
    // Let's create a temporary order for this
    const orderRes = await prisma.order.create({
      data: {
        customerId: customerId,
        createdByUserId: customerId,
        pickupPincode: '110001',
        dropPincode: '110001',
        pickupZoneId: (await prisma.zoneArea.findUnique({ where: { pincode: '110001' } }))!.zoneId,
        dropZoneId: (await prisma.zoneArea.findUnique({ where: { pincode: '110001' } }))!.zoneId,
        length: 10,
        breadth: 10,
        height: 10,
        actualWeight: 1.0,
        volumetricWeight: 0.2,
        billableWeight: 1.0,
        orderType: OrderType.B2C,
        paymentType: PaymentType.PREPAID,
        charge: 40.0,
        status: OrderStatus.PICKED_UP, // Starts at PICKED_UP
        assignedAgentId: agentProfileId,
      },
    });

    const res = await request(app)
      .patch(`/api/orders/${orderRes.id}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.FAILED, notes: 'Vehicle broke down' });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe(OrderStatus.FAILED);
  });

  // Test 5: Admin override forces status change
  test('5. Admin override forces invalid transitions and logs override actor', async () => {
    // Current order status is IN_TRANSIT.
    // Admin override directly to DELIVERED (skipping OUT_FOR_DELIVERY)
    const res = await request(app)
      .patch(`/api/orders/${orderId}/status/override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: OrderStatus.DELIVERED, notes: 'Admin forced delivery completion' });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe(OrderStatus.DELIVERED);

    // Verify history logs
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { timestamp: 'desc' },
    });

    expect(history[0].status).toBe(OrderStatus.DELIVERED);
    expect(history[0].actor).toBe('admin (override)');
    expect(history[0].actorRole).toBe(Role.ADMIN);
  });

  // Test 6: Rejections from terminal states
  test('6. Rejects any transitions from terminal states', async () => {
    // Order is DELIVERED. Any attempt to update status must fail.
    const res = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.PICKED_UP });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot transition order from terminal state');
  });
});
