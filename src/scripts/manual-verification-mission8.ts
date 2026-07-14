import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import request from 'supertest';
import app from '../index';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

async function runVerification() {
  console.log('=== STARTING MISSION 8 LIFECYCLE & CHARGE RECONCILIATION VERIFICATION ===\n');

  // 1. Clean previous verification data
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'recon_admin@test.com',
          'recon_agent@test.com',
          'recon_customer@test.com',
        ],
      },
    },
  });

  // 2. Create the Admin, Agent, and Customer users
  console.log('1. Creating Users...');
  const admin = await prisma.user.create({
    data: {
      email: 'recon_admin@test.com',
      name: 'System Admin',
      phone: '1111111111',
      passwordHash: 'dummy',
      role: Role.ADMIN,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'recon_customer@test.com',
      name: 'John Customer',
      phone: '2222222222',
      passwordHash: 'dummy',
      role: Role.CUSTOMER,
    },
  });

  const agent = await prisma.user.create({
    data: {
      email: 'recon_agent@test.com',
      name: 'Agent Alpha',
      phone: '3333333333',
      passwordHash: 'dummy',
      role: Role.AGENT,
    },
  });

  const zone = await prisma.zone.findFirst({ where: { name: 'North Zone' } });
  const zoneId = zone ? zone.id : (await prisma.zone.create({ data: { name: 'North Zone' } })).id;

  const profile = await prisma.agentProfile.create({
    data: {
      userId: agent.id,
      vehicleType: 'BIKE',
      currentZoneId: zoneId,
      verificationStatus: 'PENDING',
      availability: true,
      kycDocUrl: 'http://kyc.test',
    },
  });

  const adminToken = jwtSign(admin);
  const customerToken = jwtSign(customer);
  const agentToken = jwtSign(agent);

  // 3. Admin Approves Agent
  await request(app)
    .post(`/api/admin/agents/${profile.id}/verify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ action: 'APPROVED', notes: 'Verification approved by Admin' });

  // 4. Create pincode mappings
  await prisma.zoneArea.upsert({
    where: { pincode: '110001' },
    update: { zoneId },
    create: { pincode: '110001', zoneId },
  });

  // 5. Admin confirms an estimated order (admin-assisted)
  console.log('\n2. Admin confirming order with estimated dimensions (Length=10, Weight=1)...');
  const orderRes = await request(app)
    .post('/api/orders/admin/confirm')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      customerId: customer.id,
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
  const initialCharge = orderRes.body.order.charge; // 40.0 * 1.0 = 40.0
  console.log(`- Created Order (ID: ${orderId}, chargeIsEstimated: ${orderRes.body.order.chargeIsEstimated}, estimated charge: ₹${initialCharge})`);

  // 6. Agent attempts to transition to PICKED_UP without verification details (must fail)
  console.log('\n3. Agent trying to transition to PICKED_UP without verification inputs (Should fail)...');
  const failRes = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.PICKED_UP });

  console.log(`- Response status: ${failRes.status}`);
  console.log(`- Error message: "${failRes.body.error}"`);

  // 7. Agent submits verified dimensions at pickup (Length=20, breadth=20, height=20, weight=3.0)
  // Volumetric = 8000/5000 = 1.6Kg. Billable = max(3.0, 1.6) = 3.0Kg. New charge = 40.0 * 3.0 = ₹120.0.
  console.log('\n4. Agent submitting verified measured weight (3.0Kg) and dimensions (20x20x20) at pickup...');
  const verifyRes = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({
      status: OrderStatus.PICKED_UP,
      actualWeight: 3.0,
      length: 20,
      breadth: 20,
      height: 20,
    });

  console.log(`- Response status: ${verifyRes.status}`);
  console.log(`- Order status is now: ${verifyRes.body.order.status}`);
  console.log(`- Order chargeIsEstimated is now: ${verifyRes.body.order.chargeIsEstimated}`);
  console.log(`- Recalculated charge: ₹${verifyRes.body.order.charge}`);

  // 8. Output history timeline logs showing old vs new charge log explicitly
  console.log('\n5. Verifying Chronological OrderStatusHistory logs:');
  const historyLogs = await prisma.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: { timestamp: 'asc' },
  });

  historyLogs.forEach((log: any, index: number) => {
    console.log(`  [Log ${index + 1}] Status: ${log.status.padEnd(16)} | Actor: ${log.actor.padEnd(20)} | Notes: ${log.notes}`);
  });

  console.log('\n=== MISSION 8 LIFECYCLE & CHARGE RECONCILIATION VERIFICATION COMPLETED ===');
  await prisma.$disconnect();
}

function jwtSign(user: any): string {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
}

runVerification().catch((err) => {
  console.error(err);
  prisma.$disconnect();
});
