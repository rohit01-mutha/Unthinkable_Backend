import request from 'supertest';
import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import app from '../src/index';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

describe('Mission 9: Failed Delivery & Reschedule Integration Tests', () => {
  jest.setTimeout(30000);

  let adminToken: string;
  let customerToken: string;
  let otherCustomerToken: string;
  let agentToken: string;
  let customerId: string;
  let zoneId: string;

  beforeAll(async () => {
    // Clean database
    await prisma.agentVerificationLog.deleteMany({});
    await prisma.agentProfile.deleteMany({});
    await prisma.orderStatusHistory.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.adminAccountRequest.deleteMany({});
    await prisma.zoneArea.deleteMany({});
    await prisma.zone.deleteMany({});
    await prisma.rateCard.deleteMany({});
    await prisma.user.deleteMany({});

    // Create Zone & Area
    const zone = await prisma.zone.create({ data: { name: 'Reschedule Zone' } });
    zoneId = zone.id;
    await prisma.zoneArea.create({ data: { pincode: '110001', zoneId: zone.id } });

    // Create Rate Card
    await prisma.rateCard.create({
      data: {
        orderType: OrderType.B2C,
        intraZoneRate: 40.0,
        interZoneRate: 80.0,
        codSurcharge: 10.0,
      },
    });

    // Create Users
    const admin = await prisma.user.create({
      data: {
        email: 'resched_admin@test.com',
        name: 'System Admin',
        phone: '1111111111',
        passwordHash: 'dummy',
        role: Role.ADMIN,
      },
    });
    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET);

    const customer = await prisma.user.create({
      data: {
        email: 'resched_customer@test.com',
        name: 'Customer Resched',
        phone: '2222222222',
        passwordHash: 'dummy',
        role: Role.CUSTOMER,
      },
    });
    customerId = customer.id;
    customerToken = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, JWT_SECRET);

    const otherCust = await prisma.user.create({
      data: {
        email: 'resched_other@test.com',
        name: 'Other Cust',
        phone: '2222222223',
        passwordHash: 'dummy',
        role: Role.CUSTOMER,
      },
    });
    otherCustomerToken = jwt.sign({ id: otherCust.id, email: otherCust.email, role: otherCust.role }, JWT_SECRET);

    const agent = await prisma.user.create({
      data: {
        email: 'resched_agent@test.com',
        name: 'Agent Alpha',
        phone: '3333333333',
        passwordHash: 'dummy',
        role: Role.AGENT,
      },
    });
    agentToken = jwt.sign({ id: agent.id, email: agent.email, role: agent.role }, JWT_SECRET);

    await prisma.agentProfile.create({
      data: {
        userId: agent.id,
        vehicleType: 'BIKE',
        currentZoneId: zone.id,
        verificationStatus: 'APPROVED',
        availability: true,
        kycDocUrl: 'http://kyc.test',
      },
    });
  });

  beforeEach(async () => {
    await prisma.orderStatusHistory.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.agentProfile.updateMany({
      data: { availability: true },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test 1: Reject reschedule if order status is not FAILED
  test('1. Reject rescheduling if order is not in FAILED status', async () => {
    const orderRes = await request(app)
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

    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.order.id;

    // Reschedule should fail since status is PLACED or ASSIGNED (not FAILED)
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // 1 day future
    const res = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ deliveryDate: futureDate });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Only failed deliveries');
  });

  // Test 2: Reject reschedule if triggered by another customer
  test('2. Reject rescheduling if requested by a different customer', async () => {
    const orderRes = await request(app)
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

    const orderId = orderRes.body.order.id;

    // Admin override status to FAILED
    await request(app)
      .patch(`/api/orders/${orderId}/status/override`)
      .set('Authorization', `Bearer={adminToken}`) // Use override auth
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: OrderStatus.FAILED, notes: 'Forced Failure' });

    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .set('Authorization', `Bearer ${otherCustomerToken}`)
      .send({ deliveryDate: futureDate });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  // Test 3: Reject reschedule if target date is in the past
  test('3. Reject rescheduling if target date is in the past or invalid', async () => {
    const orderRes = await request(app)
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

    const orderId = orderRes.body.order.id;

    // Mark Failed
    await request(app)
      .patch(`/api/orders/${orderId}/status/override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: OrderStatus.FAILED });

    // Past date
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const res = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ deliveryDate: pastDate });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('in the future');
  });

  // Test 4: Successful rescheduling
  test('4. Successfully reschedules order: sets to PLACED, increments count, triggers agent assignment', async () => {
    const orderRes = await request(app)
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

    const orderId = orderRes.body.order.id;

    // Agent transitions to PICKED_UP then FAILED (to simulate real flow)
    await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.PICKED_UP });

    await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.FAILED });

    // Agent should be freed (available = true)
    const agentProfile = await prisma.agentProfile.findFirst();
    expect(agentProfile?.availability).toBe(true);

    // Reschedule
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ deliveryDate: futureDate });

    expect(res.status).toBe(200);
    expect(res.body.order.rescheduleCount).toBe(1);
    expect(res.body.order.status).toBe(OrderStatus.ASSIGNED); // Reassigned immediately because agent is free!
    expect(res.body.order.assignedAgentId).toBeDefined();

    // Verify history logs show reschedule
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });

    const reschedLog = history.find(h => h.notes && h.notes.includes('rescheduled'));
    expect(reschedLog).toBeDefined();
    expect(reschedLog?.actorRole).toBe(Role.CUSTOMER);
  });

  // Test 5: Capped at 3 attempts
  test('5. Reject rescheduling if reschedule attempts exceed 3', async () => {
    const orderRes = await request(app)
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

    const orderId = orderRes.body.order.id;

    // Loop to fail & reschedule 3 times
    for (let count = 1; count <= 3; count++) {
      // Set to FAILED
      await request(app)
        .patch(`/api/orders/${orderId}/status/override`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: OrderStatus.FAILED });

      // Reschedule
      const futureDate = new Date(Date.now() + 86400000 * count).toISOString();
      const res = await request(app)
        .post(`/api/orders/${orderId}/reschedule`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ deliveryDate: futureDate });

      expect(res.status).toBe(200);
      expect(res.body.order.rescheduleCount).toBe(count);
    }

    // Attempt 4: Set to FAILED
    await request(app)
      .patch(`/api/orders/${orderId}/status/override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: OrderStatus.FAILED });

    // Try 4th reschedule (Must fail)
    const futureDate = new Date(Date.now() + 86400000 * 4).toISOString();
    const res = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ deliveryDate: futureDate });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum reschedule attempts');
  });
});
