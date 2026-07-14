import request from 'supertest';
import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import app from '../src/index';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

describe('Mission 8: Pickup Weight Verification & Charge Reconciliation Integration Tests', () => {
  jest.setTimeout(30000);

  let adminToken: string;
  let customerToken: string;
  let customerId: string;
  let agentToken: string;
  let agentId: string;
  let agentProfileId: string;

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

    // Create Zone
    const zone = await prisma.zone.create({ data: { name: 'Verification Zone' } });
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
        email: 'recon_admin@test.com',
        name: 'System Admin',
        phone: '1111111111',
        passwordHash: 'dummy',
        role: Role.ADMIN,
      },
    });
    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET);

    const customer = await prisma.user.create({
      data: {
        email: 'recon_customer@test.com',
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
        email: 'recon_agent@test.com',
        name: 'Agent Alpha',
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

  // Test 1: Customer (Self-serve) Order directly transitions to PICKED_UP without dimensions
  test('1. Customer self-serve order skips weight verification at pickup', async () => {
    // Create customer order
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

    // Transition straight to PICKED_UP
    const statusRes = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.PICKED_UP });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.order.status).toBe(OrderStatus.PICKED_UP);
    expect(statusRes.body.order.chargeIsEstimated).toBe(false);
  });

  // Test 2: Admin-assisted order rejects PICKED_UP transition if verification inputs are missing
  test('2. Admin-assisted estimated order blocks PICKED_UP transition if dimensions are missing', async () => {
    // Create admin-assisted order
    const orderRes = await request(app)
      .post('/api/orders/admin/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId,
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
    expect(orderRes.body.order.chargeIsEstimated).toBe(true);

    // Try to transition to PICKED_UP without passing dimensions
    const statusRes = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: OrderStatus.PICKED_UP });

    expect(statusRes.status).toBe(400);
    expect(statusRes.body.error).toContain('Verification required');
  });

  // Test 3: Admin-assisted order verifies with matching dimensions, logs matches estimate
  test('3. Verify estimated order with matching dimensions successfully transitions to PICKED_UP', async () => {
    // Create admin-assisted order
    const orderRes = await request(app)
      .post('/api/orders/admin/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId,
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
    const oldCharge = orderRes.body.order.charge; // 40.0 * 1.0 = 40.0

    // Advance to PICKED_UP passing same dimensions
    const statusRes = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        status: OrderStatus.PICKED_UP,
        length: 10,
        breadth: 10,
        height: 10,
        actualWeight: 1.0,
      });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.order.status).toBe(OrderStatus.PICKED_UP);
    expect(statusRes.body.order.chargeIsEstimated).toBe(false);
    expect(statusRes.body.order.charge).toBe(oldCharge);

    // Verify verification log is generated
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });

    const verifyLog = history.find(h => h.notes && h.notes.includes('Weight verified'));
    expect(verifyLog).toBeDefined();
    expect(verifyLog?.notes).toBe('Weight verified at pickup — matches estimate');
  });

  // Test 4: Admin-assisted order verifies with differing dimensions, recalculates charge, logs revised history, sets estimated false
  test('4. Verify estimated order with differing dimensions recalculates charges and logs revised details', async () => {
    // Create admin-assisted order: length=10, breadth=10, height=10, weight=1.0. Base charge = 40.0
    const orderRes = await request(app)
      .post('/api/orders/admin/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerId,
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

    // Advance to PICKED_UP passing larger dimensions: length=20, breadth=20, height=20, actualWeight=3.0
    // Volumetric weight: 8000 / 5000 = 1.6
    // Billable weight: max(3.0, 1.6) = 3.0
    // Recalculated charge: 40.0 * 3.0 = 120.0
    const statusRes = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        status: OrderStatus.PICKED_UP,
        length: 20,
        breadth: 20,
        height: 20,
        actualWeight: 3.0,
      });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.order.status).toBe(OrderStatus.PICKED_UP);
    expect(statusRes.body.order.chargeIsEstimated).toBe(false);
    expect(statusRes.body.order.charge).toBe(120.0);
    expect(statusRes.body.order.actualWeight).toBe(3.0);

    // Verify revision log is generated
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });

    const verifyLog = history.find(h => h.notes && h.notes.includes('revised'));
    expect(verifyLog).toBeDefined();
    expect(verifyLog?.notes).toBe('Weight verified at pickup — charge revised ₹40.00 -> ₹120.00');
  });
});
