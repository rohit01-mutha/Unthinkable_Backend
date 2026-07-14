import { PrismaClient, Role, OrderType, PaymentType, OrderStatus } from '@prisma/client';
import request from 'supertest';
import app from '../index';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

async function runVerification() {
  console.log('=== STARTING MISSION 10 EMAIL NOTIFICATION LIFECYCLE VERIFICATION ===\n');

  // 1. Clean previous verification data
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'notify_admin@test.com',
          'notify_agent@test.com',
          'notify_customer@test.com',
        ],
      },
    },
  });

  // 2. Create the Admin, Agent, and Customer users
  console.log('1. Creating Users...');
  const admin = await prisma.user.create({
    data: {
      email: 'notify_admin@test.com',
      name: 'System Admin',
      phone: '1111111111',
      passwordHash: 'dummy',
      role: Role.ADMIN,
    },
  });

  const customer = await prisma.user.create({
    data: {
      email: 'notify_customer@test.com',
      name: 'John Customer',
      phone: '2222222222',
      passwordHash: 'dummy',
      role: Role.CUSTOMER,
    },
  });

  const agent = await prisma.user.create({
    data: {
      email: 'notify_agent@test.com',
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

  // 5. Customer creates order (triggers Created & Assigned emails)
  console.log('\n2. Customer booking shipment (Triggers placement & auto-assignment email notifications)...');
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
  await sleep(1000);

  // Free the agent by failing the first order
  console.log('- Agent failing the first order to release availability...');
  await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.PICKED_UP });
  await request(app)
    .patch(`/api/orders/${orderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.FAILED, notes: 'Failed first order' });
  await sleep(1500);

  // 6. Admin books estimated order for customer (Triggers placement & auto-assignment notifications)
  console.log('\n3. Admin booking estimated order for customer (Triggers placement & auto-assignment notifications)...');
  const estOrderRes = await request(app)
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
  const estOrderId = estOrderRes.body.order.id;
  await sleep(1500);

  console.log('\n4. Agent reconciling and picking up estimated order with larger dimensions (Triggers Charge Revised & Picked Up notifications)...');
  await request(app)
    .patch(`/api/orders/${estOrderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({
      status: OrderStatus.PICKED_UP,
      actualWeight: 3.0,
      length: 20,
      breadth: 20,
      height: 20,
    });
  await sleep(1500);

  // 7. Agent transitions status through In Transit, Out for Delivery, then FAILED
  console.log('\n5. Progressing status through In Transit, Out for Delivery, then FAILED...');
  await request(app)
    .patch(`/api/orders/${estOrderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.IN_TRANSIT });
  await sleep(1500);

  await request(app)
    .patch(`/api/orders/${estOrderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.OUT_FOR_DELIVERY });
  await sleep(1500);

  await request(app)
    .patch(`/api/orders/${estOrderId}/status`)
    .set('Authorization', `Bearer ${agentToken}`)
    .send({ status: OrderStatus.FAILED, notes: 'Vehicle tyre puncture' });
  await sleep(1500);

  // 8. Customer reschedules delivery (Triggers Rescheduled email)
  console.log('\n6. Customer reschedules failed order (Triggers Rescheduled & Agent Assigned notifications)...');
  const dayAfterTomorrow = new Date(Date.now() + 172800000).toISOString();
  await request(app)
    .post(`/api/orders/${estOrderId}/reschedule`)
    .set('Authorization', `Bearer ${customerToken}`)
    .send({ deliveryDate: dayAfterTomorrow });
  await sleep(1500);

  // 9. Force Deliver the order (Triggers Delivered email)
  console.log('\n7. Admin overrides status to DELIVERED (Triggers Delivered notification)...');
  await request(app)
    .patch(`/api/orders/${estOrderId}/status/override`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: OrderStatus.DELIVERED, notes: 'Delivered successfully at side gate' });
  await sleep(1500);

  console.log('\n=== MISSION 10 EMAIL NOTIFICATION LIFECYCLE VERIFICATION COMPLETED ===');
  await prisma.$disconnect();
}

function jwtSign(user: any): string {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runVerification().catch((err) => {
  console.error(err);
  prisma.$disconnect();
});
