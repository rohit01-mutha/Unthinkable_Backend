import request from 'supertest';
import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import app from '../src/index';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

describe('Mission 5: Order Creation Integration Tests', () => {
  jest.setTimeout(30000);

  let adminToken: string;
  let adminId: string;
  let customerToken: string;
  let customerId: string;

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

    // 2. Create target zones and mappings
    const zone = await prisma.zone.create({ data: { name: 'Main Zone' } });
    await prisma.zoneArea.create({ data: { pincode: '110001', zoneId: zone.id } });
    await prisma.zoneArea.create({ data: { pincode: '110002', zoneId: zone.id } });

    // 3. Create rate cards
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

    // 4. Create users and get tokens
    const admin = await prisma.user.create({
      data: {
        email: 'order_admin@test.com',
        name: 'Admin Order',
        phone: '1111111111',
        passwordHash: 'dummyhash',
        role: Role.ADMIN,
      },
    });
    adminId = admin.id;
    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET);

    const customer = await prisma.user.create({
      data: {
        email: 'order_customer@test.com',
        name: 'Customer Order',
        phone: '2222222222',
        passwordHash: 'dummyhash',
        role: Role.CUSTOMER,
      },
    });
    customerId = customer.id;
    customerToken = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, JWT_SECRET);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test 1: Quote is volatile (does not create database records)
  test('1. POST /orders/quote returns charge breakdown but does not create an order', async () => {
    const quotePayload = {
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 2.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
    };

    const res = await request(app)
      .post('/api/orders/quote')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(quotePayload);

    expect(res.status).toBe(200);
    expect(res.body.totalCharge).toBe(40.0 * 2.0); // B2C intra-zone: 40 * 2 = 80
    expect(res.body.volumetricWeight).toBe(0.2);

    // Verify no orders were created in database
    const orderCount = await prisma.order.count();
    expect(orderCount).toBe(0);
  });

  // Test 2: Customer confirms order
  test('2. Customer confirming an order sets chargeIsEstimated = false, logs history with customer actor', async () => {
    const payload = {
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 3.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.COD, // COD: surcharge 10.0
    };

    const res = await request(app)
      .post('/api/orders/confirm')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.order.charge).toBe(40.0 * 3.0 + 10.0); // 130.0
    expect(res.body.order.chargeIsEstimated).toBe(false);
    expect(res.body.order.customerId).toBe(customerId);
    expect(res.body.order.createdByUserId).toBe(customerId);

    // Verify OrderStatusHistory record is logged
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: res.body.order.id },
    });
    expect(history.length).toBeGreaterThanOrEqual(1);
    const creatorLog = history.find(h => h.actorRole === Role.CUSTOMER && h.actor === 'Customer Order');
    expect(creatorLog).toBeDefined();
    expect(creatorLog?.status).toBe(OrderStatus.PLACED);
    expect(creatorLog?.actor).toBe('Customer Order');
  });

  // Test 3: Admin-assisted order creation
  test('3. Admin confirming an order sets chargeIsEstimated = true, createdByUserId = adminId, logs admin actor history', async () => {
    const payload = {
      customerId: customerId,
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 20,
      breadth: 20,
      height: 20, // Volumetric = 8000/5000 = 1.6
      actualWeight: 1.0, // Billable = 1.6
      orderType: OrderType.B2B, // B2B intra = 50.0
      paymentType: PaymentType.PREPAID,
    };

    const res = await request(app)
      .post('/api/orders/admin/confirm')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.order.charge).toBe(50.0 * 1.6); // 80.0
    expect(res.body.order.chargeIsEstimated).toBe(true);
    expect(res.body.order.customerId).toBe(customerId);
    expect(res.body.order.createdByUserId).toBe(adminId);

    // Verify OrderStatusHistory record is logged
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: res.body.order.id },
    });
    expect(history.length).toBeGreaterThanOrEqual(1);
    const creatorLog = history.find(h => h.actorRole === Role.ADMIN && h.actor === 'Admin Order');
    expect(creatorLog).toBeDefined();
    expect(creatorLog?.status).toBe(OrderStatus.PLACED);
    expect(creatorLog?.actor).toBe('Admin Order');
  });

  // Test 4: Access Gating
  test('4. Gating restrictions enforce customers cannot access admin confirm route', async () => {
    const payload = {
      customerId: customerId,
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1.0,
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    };

    const res = await request(app)
      .post('/api/orders/admin/confirm')
      .set('Authorization', `Bearer ${customerToken}`) // Customer token on admin endpoint
      .send(payload);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });
});
