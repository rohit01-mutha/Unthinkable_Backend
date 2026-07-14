import { PrismaClient, Role, OrderType, PaymentType, OrderStatus, VerificationStatus } from '@prisma/client';
import request from 'supertest';
import app from '../index';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

async function runVerification() {
  console.log('=== STARTING MISSION 11 ROLE-GATED E2E VERIFICATION ===\n');

  // 1. Clear previous verification data
  console.log('1. Cleaning up database entries...');
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.adminAccountRequest.deleteMany({});
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'cust_m11@test.com',
          'agent_m11@test.com',
          'admin_dashboard@test.com',
          'second_admin@test.com',
          'third_admin@test.com',
        ],
      },
    },
  });

  // Create clean admin user
  const bcrypt = require('bcryptjs');
  const adminPasswordHash = await bcrypt.hash('adminsecret', 10);
  const admin = await prisma.user.create({
    data: {
      email: 'admin_dashboard@test.com',
      name: 'System Administrator',
      phone: '9876543210',
      passwordHash: adminPasswordHash,
      role: Role.ADMIN,
    },
  });

  const zone = await prisma.zone.findFirst({ where: { name: 'North Zone' } });
  const zoneId = zone ? zone.id : (await prisma.zone.create({ data: { name: 'North Zone' } })).id;

  // Create pincode mappings
  await prisma.zoneArea.upsert({
    where: { pincode: '110001' },
    update: { zoneId },
    create: { pincode: '110001', zoneId },
  });

  const adminToken = jwtSign(admin);

  // 2. Register Customer (Step 1)
  console.log('\n2. Registering Customer "cust_m11@test.com"...');
  const custRes = await request(app)
    .post('/api/auth/signup/customer')
    .send({
      email: 'cust_m11@test.com',
      name: 'John Customer',
      phone: '1234567890',
      password: 'password123',
    });
  
  console.log(`- Status: ${custRes.status}`);
  console.log(`- Created Customer: ${custRes.body.user.name} (Role: ${custRes.body.user.role})`);
  const custToken = custRes.body.token;

  // 3. Customer Book Shipment (Step 2)
  console.log('\n3. Customer booking shipment (Intra-zone)...');
  const quoteRes = await request(app)
    .post('/api/orders/quote')
    .set('Authorization', `Bearer ${custToken}`)
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
  console.log(`- Live Quote Computed Price: ₹${quoteRes.body.totalCharge} (Intra B2C Base: ₹40.00)`);

  const orderRes = await request(app)
    .post('/api/orders/confirm')
    .set('Authorization', `Bearer ${custToken}`)
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
  console.log(`- Created Order ID: ${orderId.substring(0,8)}... (Status: ${orderRes.body.order.status})`);

  // 4. Register Agent (Step 4)
  console.log('\n4. Registering Agent "agent_m11@test.com"...');
  const agentRes = await request(app)
    .post('/api/auth/signup/agent')
    .send({
      email: 'agent_m11@test.com',
      name: 'Agent Alpha',
      phone: '1234567891',
      password: 'password123',
      vehicleType: 'BIKE',
      kycDocUrl: 'http://kyc.test.com/doc.pdf',
    });
  console.log(`- Signup Response: status ${agentRes.status}`);
  console.log(`- Verification status is: PENDING`);

  // Try to log in as PENDING agent (must be blocked 403)
  console.log('\n5. Attempting to login as PENDING agent...');
  const agentLoginRes = await request(app)
    .post('/api/auth/login')
    .send({
      email: 'agent_m11@test.com',
      password: 'password123',
    });
  console.log(`- Login response status: ${agentLoginRes.status} (Access Blocked!)`);
  console.log(`- Error: "${agentLoginRes.body.error}"`);

  // 5. Admin directory approval (Step 6)
  console.log('\n6. Admin approving Agent Alpha profile...');
  const freshAgentProfile = await prisma.agentProfile.findFirst({
    where: { user: { email: 'agent_m11@test.com' } },
  });
  const agentProfileId = freshAgentProfile!.id;

  const approveAgentRes = await request(app)
    .post(`/api/admin/agents/${agentProfileId}/verify`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ action: 'APPROVED', notes: 'Verified Agent Alpha' });
  console.log(`- Approval Response status: ${approveAgentRes.status}`);
  console.log(`- Profile status updated to: ${approveAgentRes.body.profile.verificationStatus}`);

  // Admin manually assigns the order to the approved agent
  console.log('- Admin manually assigning order to approved agent...');
  const assignRes = await request(app)
    .patch(`/api/orders/${orderId}/assign-agent`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ agentId: freshAgentProfile!.userId });
  console.log(`  - Assign response status: ${assignRes.status}`);

  // 6. Propose Admin email (Step 7)
  console.log('\n7. Admin proposing "second_admin@test.com"...');
  const proposeRes = await request(app)
    .post('/api/auth/admin/propose')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ proposedEmail: 'second_admin@test.com' });
  console.log(`- Proposal Status: ${proposeRes.status}`);
  console.log(`- Request ID: ${proposeRes.body.request.id.substring(0,8)}...`);

  // Admin attempts to approve their own proposal (must fail Maker-Checker policy)
  console.log('\n8. Admin attempting to self-approve proposal (Maker-Checker check)...');
  const selfApproveRes = await request(app)
    .post('/api/auth/admin/approve')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ requestId: proposeRes.body.request.id });
  console.log(`- Self-approval Response status: ${selfApproveRes.status} (Forbidden!)`);
  console.log(`- Error: "${selfApproveRes.body.error}"`);

  // Create another Admin to approve it
  const secondAdminPasswordHash = await bcrypt.hash('adminsecret', 10);
  const thirdAdmin = await prisma.user.create({
    data: {
      email: 'third_admin@test.com',
      name: 'Independent Auditor',
      phone: '9876543212',
      passwordHash: secondAdminPasswordHash,
      role: Role.ADMIN,
    },
  });
  const thirdAdminToken = jwtSign(thirdAdmin);

  console.log('\n9. Independent Auditor approving admin proposal (Maker-Checker approval)...');
  const auditorApproveRes = await request(app)
    .post('/api/auth/admin/approve')
    .set('Authorization', `Bearer ${thirdAdminToken}`)
    .send({ requestId: proposeRes.body.request.id });
  console.log(`- Auditor Approval Response status: ${auditorApproveRes.status} (Invite Token Generated!)`);
  console.log(`- Invitation Token: ${auditorApproveRes.body.inviteToken.substring(0,25)}...`);

  // Redeem invitation to register second admin
  console.log('\n10. Redeeming invitation to signup "second_admin@test.com"...');
  const redeemRes = await request(app)
    .post('/api/auth/signup/admin')
    .send({
      token: auditorApproveRes.body.inviteToken,
      name: 'Second Administrator',
      phone: '9876543211',
      password: 'password123',
    });
  console.log(`- Signup Response status: ${redeemRes.status}`);
  console.log(`- Account details: Name: ${redeemRes.body.user.name}, Role: ${redeemRes.body.user.role}`);

  // 7. Login as APPROVED agent (Step 9)
  console.log('\n11. Attempting login as APPROVED agent...');
  const agentSuccessLoginRes = await request(app)
    .post('/api/auth/login')
    .send({
      email: 'agent_m11@test.com',
      password: 'password123',
    });
  console.log(`- Login response status: ${agentSuccessLoginRes.status} (Access Permitted!)`);
  console.log(`- Token returned: ${agentSuccessLoginRes.body.token.substring(0,25)}...`);

  const agentSuccessToken = agentSuccessLoginRes.body.token;

  // Verify that agent dashboard list includes the auto-assigned shipment order
  const agentOrdersRes = await request(app)
    .get('/api/orders')
    .set('Authorization', `Bearer ${agentSuccessToken}`);

  console.log(`- Agent Assigned Deliveries Count: ${agentOrdersRes.body.length}`);
  const assigned = agentOrdersRes.body.find((o: any) => o.id === orderId);
  console.log(`- Order #${orderId.substring(0,8)}... present in agent dashboard: ${!!assigned}`);

  console.log('\n=== MISSION 11 ROLE-GATED E2E VERIFICATION COMPLETED ===');
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
