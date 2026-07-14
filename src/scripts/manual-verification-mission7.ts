import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import request from 'supertest';
import app from '../index';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

async function runVerification() {
  console.log('=== STARTING MISSION 7 LIFECYCLE VERIFICATION ===\n');

  // 1. Clean previous verification data
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'verify_admin@test.com',
          'lifecycle_agent_a@test.com',
          'lifecycle_customer_a@test.com',
        ],
      },
    },
  });

  // 2. Create the Admin, Agent, and Customer users
  console.log('1. Creating Users...');
  const admin = await prisma.user.create({
    data: {
      email: 'verify_admin@test.com',
      name: 'System Admin',
      phone: '1111111111',
      passwordHash: 'dummy',
      role: Role.ADMIN,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'lifecycle_customer_a@test.com',
      name: 'Lifecycle Customer A',
      phone: '8887776666',
      passwordHash: 'dummy',
      role: Role.CUSTOMER,
    },
  });

  const agent = await prisma.user.create({
    data: {
      email: 'lifecycle_agent_a@test.com',
      name: 'Lifecycle Agent A',
      phone: '9998887777',
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

  console.log(`- Created Agent Profile (ID: ${profile.id}, Status: PENDING)`);

  const adminToken = jwtSign(admin);
  const customerToken = jwtSign(customer);
  const agentToken = jwtSign(agent);

  // 3. Admin Approves Agent
  console.log('\n2. Admin Approving Agent...');
  const approveRes = await request(app)
    .post(`/api/admin/agents/${profile.id}/verify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ action: 'APPROVED', notes: 'Verification approved by Admin' });

  console.log(`- Status code: ${approveRes.status}`);
  console.log(`- Message: ${approveRes.body.message}`);

  // 4. Customer Creates Order
  console.log('\n3. Customer Placing Shipment Order...');
  // Ensure pincodes are linked to zone
  await prisma.zoneArea.upsert({
    where: { pincode: '110001' },
    update: { zoneId },
    create: { pincode: '110001', zoneId },
  });
  await prisma.zoneArea.upsert({
    where: { pincode: '110002' },
    update: { zoneId },
    create: { pincode: '110002', zoneId },
  });

  const orderRes = await request(app)
    .post('/api/orders/confirm')
    .set('Authorization', `Bearer ${customerToken}`)
    .send({
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1.5,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
    });

  console.log(`- Status code: ${orderRes.status}`);
  const orderId = orderRes.body.order.id;
  console.log(`- Created Order (ID: ${orderId}, Status: ${orderRes.body.order.status}, AssignedAgentId: ${orderRes.body.order.assignedAgentId})`);

  // 5. Agent progresses status through full lifecycle
  console.log('\n4. Agent Advancing Lifecycle Step-by-Step...');
  const steps = [
    OrderStatus.PICKED_UP,
    OrderStatus.IN_TRANSIT,
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.DELIVERED,
  ];

  for (const step of steps) {
    const stepRes = await request(app)
      .patch(`/api/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ status: step, notes: `Agent status progression to ${step}` });

    console.log(`- Transition to ${step}: Response code ${stepRes.status}, Current Status is ${stepRes.body.order.status}`);
  }

  // 6. Output OrderStatusHistory (verify append-only)
  console.log('\n5. Verifying Chronological OrderStatusHistory logs:');
  const historyLogs = await prisma.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: { timestamp: 'asc' },
  });

  historyLogs.forEach((log: any, index: number) => {
    console.log(`  [Log ${index + 1}] Status: ${log.status.padEnd(16)} | Actor: ${log.actor.padEnd(20)} | Role: ${log.actorRole.padEnd(10)} | Notes: ${log.notes}`);
  });

  // 7. Verify Admin Override Status
  console.log('\n6. Testing Admin Force Override (direct transition PLACED -> DELIVERED)...');
  const tempOrder = await prisma.order.create({
    data: {
      customerId: customer.id,
      createdByUserId: customer.id,
      pickupPincode: '110001',
      dropPincode: '110002',
      pickupZoneId: zoneId,
      dropZoneId: zoneId,
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1.0,
      volumetricWeight: 0.2,
      billableWeight: 1.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
      charge: 40.0,
      status: OrderStatus.PLACED,
    },
  });

  const overrideRes = await request(app)
    .patch(`/api/orders/${tempOrder.id}/status/override`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: OrderStatus.DELIVERED, notes: 'Forced completion by admin' });

  console.log(`- Override response status: ${overrideRes.status}`);
  console.log(`- Order Status is now: ${overrideRes.body.order.status}`);

  const overrideLogs = await prisma.orderStatusHistory.findMany({
    where: { orderId: tempOrder.id },
    orderBy: { timestamp: 'asc' },
  });
  console.log('- Force Override History Logs:');
  overrideLogs.forEach((log: any, index: number) => {
    console.log(`  [Log ${index + 1}] Status: ${log.status.padEnd(16)} | Actor: ${log.actor.padEnd(20)} | Role: ${log.actorRole.padEnd(10)} | Notes: ${log.notes}`);
  });

  console.log('\n=== MISSION 7 LIFECYCLE VERIFICATION COMPLETED ===');
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
