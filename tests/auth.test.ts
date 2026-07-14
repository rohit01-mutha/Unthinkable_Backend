import request from 'supertest';
import { PrismaClient, Role, VerificationStatus } from '@prisma/client';
import app from '../src/index';
import bcrypt from 'bcryptjs';
import execa from 'child_process';

const prisma = new PrismaClient();

describe('Mission 2: Auth & Role-Gated Onboarding Integration Tests', () => {
  jest.setTimeout(30000);

  beforeAll(async () => {
    // Clear relevant tables to ensure clean state
    await prisma.agentVerificationLog.deleteMany({});
    await prisma.agentProfile.deleteMany({});
    await prisma.orderStatusHistory.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.adminAccountRequest.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let firstAdminToken: string;
  let firstAdminId: string;
  let secondAdminId: string;
  let secondAdminToken: string;
  let testAgentProfileId: string;
  let testAgentUserId: string;

  // Test 1: First Admin Seed Works
  test('1. First admin seeding works via CLI script', async () => {
    // Run the seed-admin script using ts-node dynamically
    const adminEmail = 'admin1@test.com';
    const adminPassword = 'adminpassword123';
    
    // We execute the seed script using child process
    const runSeed = () => {
      return new Promise<void>((resolve, reject) => {
        const { exec } = require('child_process');
        exec(
          `npx ts-node src/scripts/seed-admin.ts ${adminEmail} "Admin One" "1234567890" ${adminPassword}`,
          (error: any, stdout: string, stderr: string) => {
            if (error) {
              reject(new Error(stderr || error.message));
            } else {
              resolve();
            }
          }
        );
      });
    };

    await runSeed();

    // Verify admin was created in DB
    const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    expect(admin).toBeDefined();
    expect(admin!.role).toBe(Role.ADMIN);
    firstAdminId = admin!.id;

    // Verify double-seeding fails (one-time CLI restriction)
    await expect(runSeed()).rejects.toThrow();

    // Log in as the seeded admin to get the token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: adminEmail, password: adminPassword });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    firstAdminToken = loginRes.body.token;
  });

  // Test 2: Customer Signup & Login
  test('2. Customer signup and login works instantly', async () => {
    const customerEmail = 'customer@test.com';
    const customerPassword = 'customerpassword123';

    // Signup customer
    const signupRes = await request(app)
      .post('/api/auth/signup/customer')
      .send({
        email: customerEmail,
        name: 'John Customer',
        phone: '9876543210',
        password: customerPassword,
      });

    expect(signupRes.status).toBe(201);
    expect(signupRes.body.token).toBeDefined();
    expect(signupRes.body.user.role).toBe(Role.CUSTOMER);

    // Login customer
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: customerEmail, password: customerPassword });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
  });

  // Test 3: Agent Signup & Restricted Access
  test('3. Agent signup is PENDING and blocks login & route access', async () => {
    const agentEmail = 'agent@test.com';
    const agentPassword = 'agentpassword123';

    // Signup Agent
    const signupRes = await request(app)
      .post('/api/auth/signup/agent')
      .send({
        email: agentEmail,
        name: 'Delivery Agent',
        phone: '5555555555',
        password: agentPassword,
        vehicleType: 'Bike',
        kycDocUrl: 'https://docs.com/kyc.pdf',
      });

    expect(signupRes.status).toBe(201);
    expect(signupRes.body.profileId).toBeDefined();
    testAgentProfileId = signupRes.body.profileId;
    testAgentUserId = signupRes.body.userId;

    // Verify AgentProfile status in DB is PENDING
    const profile = await prisma.agentProfile.findUnique({
      where: { id: testAgentProfileId },
    });
    expect(profile!.verificationStatus).toBe(VerificationStatus.PENDING);

    // Verify AgentVerificationLog has a SUBMITTED entry
    const logs = await prisma.agentVerificationLog.findMany({
      where: { agentProfileId: testAgentProfileId },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe('SUBMITTED');

    // Attempt login as PENDING agent (must fail with 403)
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: agentEmail, password: agentPassword });

    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error).toContain('pending verification');

    // Test route protection: PENDING agent cannot access protected routes
    // Even if we forge a JWT token manually (the middleware checks the DB status)
    const tempToken = require('jsonwebtoken').sign(
      { id: testAgentUserId, email: agentEmail, role: Role.AGENT },
      process.env.JWT_SECRET || 'scaffolding_secret_key'
    );

    const protectedRes = await request(app)
      .post('/api/admin/agents/dummy/verify') // Some random protected route
      .set('Authorization', `Bearer ${tempToken}`)
      .send({});

    expect(protectedRes.status).toBe(403);
    expect(protectedRes.body.error).toContain('restricted until approved');
  });

  // Test 4: Admin Agent Verification
  test('4. Admin can approve agent profile and allow login', async () => {
    // Approve the agent
    const verifyRes = await request(app)
      .post(`/api/admin/agents/${testAgentProfileId}/verify`)
      .set('Authorization', `Bearer ${firstAdminToken}`)
      .send({
        action: VerificationStatus.APPROVED,
        notes: 'KYC verified and approved.',
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.profile.verificationStatus).toBe(VerificationStatus.APPROVED);

    // Verify AgentVerificationLog has an APPROVED entry
    const logs = await prisma.agentVerificationLog.findMany({
      where: { agentProfileId: testAgentProfileId },
      orderBy: { timestamp: 'desc' },
    });
    expect(logs.length).toBe(2);
    expect(logs[0].action).toBe('APPROVED');
    expect(logs[0].actedByUserId).toBe(firstAdminId);

    // Agent should now be able to log in successfully
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'agent@test.com', password: 'agentpassword123' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
  });

  // Test 5: Maker-Checker Admin Account Creation
  test('5. Maker-checker admin flow: admin cannot approve their own proposal', async () => {
    const newAdminEmail = 'admin2@test.com';

    // Admin 1 proposes Admin 2
    const proposeRes = await request(app)
      .post('/api/auth/admin/propose')
      .set('Authorization', `Bearer ${firstAdminToken}`)
      .send({ proposedEmail: newAdminEmail });

    expect(proposeRes.status).toBe(201);
    expect(proposeRes.body.request.proposedEmail).toBe(newAdminEmail);
    const requestId = proposeRes.body.request.id;

    // Admin 1 attempts to approve their own proposal (must be rejected)
    const selfApproveRes = await request(app)
      .post('/api/auth/admin/approve')
      .set('Authorization', `Bearer ${firstAdminToken}`)
      .send({ requestId });

    expect(selfApproveRes.status).toBe(400);
    expect(selfApproveRes.body.error).toContain('Maker-checker policy violation');

    // Create a second admin directly in DB to bypass invite flow so they can approve the request
    const secondAdminHash = await bcrypt.hash('adminpassword456', 10);
    const secondAdmin = await prisma.user.create({
      data: {
        email: 'admin3_approver@test.com',
        name: 'Admin Three Approver',
        phone: '1112223333',
        passwordHash: secondAdminHash,
        role: Role.ADMIN,
      },
    });
    secondAdminId = secondAdmin.id;

    // Log in as second admin
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin3_approver@test.com', password: 'adminpassword456' });
    secondAdminToken = loginRes.body.token;

    // Admin 3 approves the proposal of Admin 1 (must succeed)
    const approveRes = await request(app)
      .post('/api/auth/admin/approve')
      .set('Authorization', `Bearer ${secondAdminToken}`)
      .send({ requestId });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.inviteToken).toBeDefined();
    const inviteToken = approveRes.body.inviteToken;

    // Redeem invite token to create Admin 2
    const signupRes = await request(app)
      .post('/api/auth/signup/admin')
      .send({
        token: inviteToken,
        name: 'Admin Two Name',
        phone: '9998887777',
        password: 'admin2password123',
      });

    expect(signupRes.status).toBe(201);
    expect(signupRes.body.user.email).toBe(newAdminEmail);
    expect(signupRes.body.user.role).toBe(Role.ADMIN);
  });
});
