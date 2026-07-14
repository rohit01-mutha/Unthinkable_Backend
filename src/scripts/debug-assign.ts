import request from 'supertest';
import app from '../index';
import { PrismaClient, Role, OrderType, PaymentType } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

async function main() {
  console.log('--- DIAGNOSTIC RUN ---');

  // Seed database
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.adminAccountRequest.deleteMany({});
  await prisma.zoneArea.deleteMany({});
  await prisma.zone.deleteMany({});
  await prisma.rateCard.deleteMany({});
  await prisma.user.deleteMany({});

  const nZone = await prisma.zone.create({ data: { name: 'North Zone' } });
  await prisma.zoneArea.create({ data: { pincode: '110001', zoneId: nZone.id } });
  await prisma.zoneArea.create({ data: { pincode: '110002', zoneId: nZone.id } });

  await prisma.rateCard.create({
    data: {
      orderType: OrderType.B2C,
      intraZoneRate: 40.0,
      interZoneRate: 80.0,
      codSurcharge: 10.0,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'assign_customer@test.com',
      name: 'John Customer',
      phone: '2222222222',
      passwordHash: 'dummy',
      role: Role.CUSTOMER,
    },
  });

  const userA = await prisma.user.create({
    data: {
      email: 'agent_a@test.com',
      name: 'Agent Alpha',
      phone: '3333333333',
      passwordHash: 'dummy',
      role: Role.AGENT,
    },
  });
  await prisma.agentProfile.create({
    data: {
      userId: userA.id,
      vehicleType: 'BIKE',
      currentZoneId: nZone.id,
      verificationStatus: 'APPROVED',
      availability: true,
      kycDocUrl: 'https://kyc.test.com/doc.pdf',
    },
  });

  const token = jwt.sign({ id: customer.id, email: customer.email, role: customer.role }, JWT_SECRET);

  console.log('Triggering POST /api/orders/confirm...');
  const res = await request(app)
    .post('/api/orders/confirm')
    .set('Authorization', `Bearer ${token}`)
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

  console.log('STATUS RECEIVED:', res.status);
  console.log('RESPONSE BODY:', res.body);
  process.exit(0);
}
void main();
