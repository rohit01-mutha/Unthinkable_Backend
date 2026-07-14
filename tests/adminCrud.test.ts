import request from 'supertest';
import { PrismaClient, Role, OrderType } from '@prisma/client';
import app from '../src/index';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

describe('Mission 3: Zone & Rate Card Management CRUD Integration Tests', () => {
  jest.setTimeout(30000);

  let adminToken: string;
  let customerToken: string;
  let activeZoneId: string;

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

    // 2. Create an admin
    const admin = await prisma.user.create({
      data: {
        email: 'crud_admin@test.com',
        name: 'Admin CRUD',
        phone: '1231231234',
        passwordHash: 'dummyhash',
        role: Role.ADMIN,
      },
    });
    adminToken = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET);

    // 3. Create a customer
    const customer = await prisma.user.create({
      data: {
        email: 'crud_customer@test.com',
        name: 'Customer CRUD',
        phone: '3213214321',
        passwordHash: 'dummyhash',
        role: Role.CUSTOMER,
      },
    });
    customerToken = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, JWT_SECRET);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test 1: Access Control Gating
  test('1. Non-admin user (customer) is blocked with 403 Forbidden', async () => {
    const res = await request(app)
      .get('/api/admin/zones')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  // Test 2: Zones CRUD operations
  test('2. Admin can create, list, and delete Zones', async () => {
    // Create Zone
    const createRes = await request(app)
      .post('/api/admin/zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'East Zone' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.zone.name).toBe('East Zone');
    activeZoneId = createRes.body.zone.id;

    // Duplicate creation must fail
    const duplicateRes = await request(app)
      .post('/api/admin/zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'East Zone' });
    expect(duplicateRes.status).toBe(400);

    // List Zones
    const listRes = await request(app)
      .get('/api/admin/zones')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    expect(listRes.body.some((z: any) => z.name === 'East Zone')).toBe(true);

    // Delete Zone
    const deleteRes = await request(app)
      .delete(`/api/admin/zones/${activeZoneId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleteRes.status).toBe(200);

    // Verify deleted
    const verifyListRes = await request(app)
      .get('/api/admin/zones')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(verifyListRes.body.some((z: any) => z.id === activeZoneId)).toBe(false);
  });

  // Test 3: ZoneArea Mappings
  test('3. Admin can map a pincode to a zone, list mappings, and delete mappings', async () => {
    // Create target zone first
    const zoneRes = await request(app)
      .post('/api/admin/zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Central Zone' });
    const zoneId = zoneRes.body.zone.id;

    // Map Pincode
    const mapRes = await request(app)
      .post('/api/admin/zones/areas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pincode: '700001', zoneId });

    expect(mapRes.status).toBe(201);
    expect(mapRes.body.area.pincode).toBe('700001');

    // List mappings
    const listRes = await request(app)
      .get('/api/admin/zones/areas')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.some((a: any) => a.pincode === '700001')).toBe(true);

    // Delete mapping
    const deleteRes = await request(app)
      .delete('/api/admin/zones/areas/700001')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleteRes.status).toBe(200);
  });

  // Test 4: Rate Cards
  test('4. Admin can upsert and list B2B and B2C RateCards', async () => {
    // Upsert B2B card
    const b2bRes = await request(app)
      .post('/api/admin/rate-cards')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        orderType: OrderType.B2B,
        intraZoneRate: 55.5,
        interZoneRate: 110.0,
        codSurcharge: 20.0,
      });

    expect(b2bRes.status).toBe(200);
    expect(b2bRes.body.rateCard.intraZoneRate).toBe(55.5);
    expect(b2bRes.body.rateCard.orderType).toBe(OrderType.B2B);

    // Upsert B2C card
    const b2cRes = await request(app)
      .post('/api/admin/rate-cards')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        orderType: OrderType.B2C,
        intraZoneRate: 45.0,
        interZoneRate: 90.0,
        codSurcharge: 12.5,
      });

    expect(b2cRes.status).toBe(200);
    expect(b2cRes.body.rateCard.intraZoneRate).toBe(45.0);

    // List rate cards
    const listRes = await request(app)
      .get('/api/admin/rate-cards')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(2);
    expect(listRes.body.find((r: any) => r.orderType === OrderType.B2B).intraZoneRate).toBe(55.5);
  });
});
