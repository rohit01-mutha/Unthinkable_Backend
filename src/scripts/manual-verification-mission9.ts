import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import request from 'supertest';
import app from '../index';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

async function runVerification() {
  console.log('=== STARTING MISSION 9 FAILED DELIVERY & RESCHEDULE VERIFICATION ===\n');

  // 1. Clean previous verification data
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'resched_admin@test.com',
          'resched_agent@test.com',
          'resched_customer@test.com',
        ],
      },
    },
  });

  // 2. Create the Admin, Agent, and Customer users
  console.log('1. Creating Users...');
  const admin = await prisma.user.create({
    data: {
      email: 'resched_admin@test.com',
      name: 'System Admin',
      phone: '1111111111',
      passwordHash: 'dummy',
      role: Role.ADMIN,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'resched_customer@test.com',
      name: 'Customer Resched',
      phone: '2222222222',
      passwordHash: 'dummy',
      role: Role.CUSTOMER,
    },
  });

  const agent = await prisma.user.create({
    data: {
      email: 'resched_agent@test.com',
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

  // 5. Customer places order
  console.log('\n2. Customer placing shipment order...');
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
  console.log(`- Created Order (ID: ${orderId}, Status: ${orderRes.body.order.status}, charge: ₹${orderRes.body.order.charge})`);

  // 6. Agent picks up package and then marks it FAILED
  console.log('\n3. Agent picking up package and marking delivery as FAILED...');
  await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.PICKED_UP });

  const failRes = await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.FAILED, notes: 'Customer was not available at address' });

  console.log(`- Status is now: ${failRes.body.order.status}`);
  const freshAgent = await prisma.agentProfile.findUnique({ where: { id: profile.id } });
  console.log(`- Agent availability is set back to: ${freshAgent?.availability} (released!)`);

  // 7. Customer reschedules delivery
  console.log('\n4. Customer reschedules the delivery for tomorrow...');
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const reschedRes = await request(app)
    .post(`/api/orders/${orderId}/reschedule`)
    .set('Authorization', `Bearer ${customerToken}`)
    .send({ deliveryDate: tomorrow });

  console.log(`- Response status: ${reschedRes.status}`);
  console.log(`- Order status reset to: ${reschedRes.body.order.status} (auto-assigned to free agent!)`);
  console.log(`- Assigned agent ID: ${reschedRes.body.order.assignedAgentId}`);
  console.log(`- Reschedule count is: ${reschedRes.body.order.rescheduleCount}`);
  console.log(`- Order charge remains locked at: ₹${reschedRes.body.order.charge}`);

  // 8. Reschedule 2 more times to hit limit
  console.log('\n5. Performing 2 more reschedules to reach the maximum limit...');
  for (let c = 2; c <= 3; c++) {
    // Override status to failed first (to allow rescheduling)
    await request(app)
      .patch(`/api/orders/${orderId}/status/override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: OrderStatus.FAILED, notes: `Simulated failure #${c}` });

    const futDate = new Date(Date.now() + 86400000 * c).toISOString();
    const loopRes = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ deliveryDate: futDate });

    console.log(`  - Reschedule #${c} response: status ${loopRes.status}, count: ${loopRes.body.order.rescheduleCount}`);
  }

  // 9. Attempt 4th reschedule (must fail)
  console.log('\n6. Attempting 4th reschedule (Should be blocked)...');
  await request(app)
    .patch(`/api/orders/${orderId}/status/override`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: OrderStatus.FAILED });

  const pastLimitDate = new Date(Date.now() + 86400000 * 4).toISOString();
  const blockedRes = await request(app)
    .post(`/api/orders/${orderId}/reschedule`)
    .set('Authorization', `Bearer ${customerToken}`)
    .send({ deliveryDate: pastLimitDate });

  console.log(`- Response status: ${blockedRes.status}`);
  console.log(`- Error message: "${blockedRes.body.error}"`);

  // 10. Print chronological OrderStatusHistory logs
  console.log('\n7. Verifying Chronological OrderStatusHistory logs:');
  const historyLogs = await prisma.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: { timestamp: 'asc' },
  });

  historyLogs.forEach((log: any, index: number) => {
    console.log(`  [Log ${index + 1}] Status: ${log.status.padEnd(16)} | Actor: ${log.actor.padEnd(20)} | Notes: ${log.notes}`);
  });

  console.log('\n=== MISSION 9 FAILED DELIVERY & RESCHEDULE VERIFICATION COMPLETED ===');
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
