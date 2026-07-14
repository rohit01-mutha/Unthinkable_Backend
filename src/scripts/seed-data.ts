import { PrismaClient, OrderType, PaymentType, OrderStatus, Role, VerificationStatus, AgentVerificationAction } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('--- STARTING COMPREHENSIVE DATABASE SEEDING ---');

  // 1. Clean Database
  console.log('1. Cleaning database tables...');
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.adminAccountRequest.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.zoneArea.deleteMany({});
  await prisma.zone.deleteMany({});
  await prisma.rateCard.deleteMany({});

  // 2. Seed Zones
  console.log('2. Seeding Zones...');
  const northZone = await prisma.zone.create({ data: { name: 'North Zone' } });
  const southZone = await prisma.zone.create({ data: { name: 'South Zone' } });
  const westZone = await prisma.zone.create({ data: { name: 'West Zone' } });
  console.log(`- Seeded 3 Zones: ${northZone.name}, ${southZone.name}, ${westZone.name}`);

  // 3. Seed Zone Areas (Pincode Mappings)
  console.log('3. Seeding 11 Pincode Mappings (ZoneArea)...');
  const mappings = [
    // North Zone
    { pincode: '110001', zoneId: northZone.id },
    { pincode: '110002', zoneId: northZone.id },
    { pincode: '110003', zoneId: northZone.id },
    // South Zone
    { pincode: '560001', zoneId: southZone.id },
    { pincode: '560002', zoneId: southZone.id },
    { pincode: '560003', zoneId: southZone.id },
    { pincode: '560004', zoneId: southZone.id },
    // West Zone
    { pincode: '400001', zoneId: westZone.id },
    { pincode: '400002', zoneId: westZone.id },
    { pincode: '400003', zoneId: westZone.id },
    { pincode: '400004', zoneId: westZone.id },
  ];

  for (const map of mappings) {
    await prisma.zoneArea.create({
      data: { pincode: map.pincode, zoneId: map.zoneId },
    });
  }
  console.log(`- Seeded ${mappings.length} pincode mappings.`);

  // 4. Seed Rate Cards
  console.log('4. Seeding Rate Cards...');
  const b2bRate = await prisma.rateCard.create({
    data: {
      orderType: OrderType.B2B,
      intraZoneRate: 50.0,
      interZoneRate: 100.0,
      codSurcharge: 15.0,
    },
  });

  const b2cRate = await prisma.rateCard.create({
    data: {
      orderType: OrderType.B2C,
      intraZoneRate: 40.0,
      interZoneRate: 80.0,
      codSurcharge: 10.0,
    },
  });

  console.log(`- Seeded B2B Rate Card: Intra ₹50, Inter ₹100`);
  console.log(`- Seeded B2C Rate Card: Intra ₹40, Inter ₹80`);

  // 5. Seed Users & Profiles
  console.log('5. Seeding users...');
  
  // Hashed Passwords
  const adminPasswordHash = await bcrypt.hash('adminsecret', 10);
  const passwordHash = await bcrypt.hash('password123', 10);

  // Admin User
  const admin = await prisma.user.create({
    data: {
      email: 'admin@test.com',
      name: 'System Admin',
      phone: '9998887777',
      passwordHash: adminPasswordHash,
      role: Role.ADMIN,
    },
  });
  console.log(`- Admin Seeded: admin@test.com (password: adminsecret)`);

  // Customer User
  const customer = await prisma.user.create({
    data: {
      email: 'customer@test.com',
      name: 'John Customer',
      phone: '8887776666',
      passwordHash,
      role: Role.CUSTOMER,
    },
  });
  console.log(`- Customer Seeded: customer@test.com (password: password123)`);

  // Agent 1: Agent Alpha (North Zone, Approved, availability = false because they have an active order)
  const userAlpha = await prisma.user.create({
    data: {
      email: 'agent_alpha@test.com',
      name: 'Agent Alpha',
      phone: '1111111111',
      passwordHash,
      role: Role.AGENT,
    },
  });
  const profileAlpha = await prisma.agentProfile.create({
    data: {
      userId: userAlpha.id,
      verificationStatus: VerificationStatus.APPROVED,
      vehicleType: 'BIKE',
      currentZoneId: northZone.id,
      availability: false, // will hold active order 2
      kycDocUrl: 'https://kyc.test.com/doc1.pdf',
    },
  });
  await prisma.agentVerificationLog.create({
    data: {
      agentProfileId: profileAlpha.id,
      action: AgentVerificationAction.APPROVED,
      actedByUserId: admin.id,
      notes: 'Initial seed approval',
    },
  });

  // Agent 2: Agent Beta (South Zone, Approved, availability = false because they have an active order)
  const userBeta = await prisma.user.create({
    data: {
      email: 'agent_beta@test.com',
      name: 'Agent Beta',
      phone: '2222222222',
      passwordHash,
      role: Role.AGENT,
    },
  });
  const profileBeta = await prisma.agentProfile.create({
    data: {
      userId: userBeta.id,
      verificationStatus: VerificationStatus.APPROVED,
      vehicleType: 'VAN',
      currentZoneId: southZone.id,
      availability: false, // will hold active order 3
      kycDocUrl: 'https://kyc.test.com/doc2.pdf',
    },
  });
  await prisma.agentVerificationLog.create({
    data: {
      agentProfileId: profileBeta.id,
      action: AgentVerificationAction.APPROVED,
      actedByUserId: admin.id,
      notes: 'Initial seed approval',
    },
  });

  // Agent 3: Agent Gamma (West Zone, Approved, availability = true because they have a terminal order)
  const userGamma = await prisma.user.create({
    data: {
      email: 'agent_gamma@test.com',
      name: 'Agent Gamma',
      phone: '3333333333',
      passwordHash,
      role: Role.AGENT,
    },
  });
  const profileGamma = await prisma.agentProfile.create({
    data: {
      userId: userGamma.id,
      verificationStatus: VerificationStatus.APPROVED,
      vehicleType: 'TRUCK',
      currentZoneId: westZone.id,
      availability: true, // free
      kycDocUrl: 'https://kyc.test.com/doc3.pdf',
    },
  });
  await prisma.agentVerificationLog.create({
    data: {
      agentProfileId: profileGamma.id,
      action: AgentVerificationAction.APPROVED,
      actedByUserId: admin.id,
      notes: 'Initial seed approval',
    },
  });

  console.log('- 3 Pre-Approved Agents Seeded: agent_alpha@test.com, agent_beta@test.com, agent_gamma@test.com');

  // 6. Seed Sample Orders
  console.log('6. Seeding 5 Sample Orders...');
  
  // Order 1: PLACED, unassigned (awaiting agent, pickup North, drop South)
  const order1 = await prisma.order.create({
    data: {
      customerId: customer.id,
      createdByUserId: customer.id,
      pickupPincode: '110001',
      dropPincode: '560001',
      pickupZoneId: northZone.id,
      dropZoneId: southZone.id,
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1.0,
      volumetricWeight: 0.2,
      billableWeight: 1.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
      charge: 80.00, // inter-zone B2C rate applied
      chargeIsEstimated: false,
      status: OrderStatus.PLACED,
      pendingAssignment: true,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order1.id,
      status: OrderStatus.PLACED,
      actor: 'John Customer',
      actorRole: Role.CUSTOMER,
      notes: 'Order created by customer (self-serve).',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order1.id,
      status: OrderStatus.PLACED,
      actor: 'system',
      actorRole: Role.ADMIN,
      notes: 'Awaiting agent — none free in zone',
    },
  });

  // Order 2: ASSIGNED to Agent Alpha (pickup North, drop North)
  const order2 = await prisma.order.create({
    data: {
      customerId: customer.id,
      createdByUserId: customer.id,
      pickupPincode: '110002',
      dropPincode: '110003',
      pickupZoneId: northZone.id,
      dropZoneId: northZone.id,
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 2.0,
      volumetricWeight: 0.2,
      billableWeight: 2.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
      charge: 80.00, // intra-zone B2C: 40 * 2 = 80
      chargeIsEstimated: false,
      status: OrderStatus.ASSIGNED,
      assignedAgentId: profileAlpha.id,
      pendingAssignment: false,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order2.id,
      status: OrderStatus.PLACED,
      actor: 'John Customer',
      actorRole: Role.CUSTOMER,
      notes: 'Order created by customer (self-serve).',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order2.id,
      status: OrderStatus.ASSIGNED,
      actor: 'system',
      actorRole: Role.ADMIN,
      notes: `System auto-assigned agent: Agent Alpha`,
    },
  });

  // Order 3: PICKED_UP by Agent Beta (pickup South, drop South)
  const order3 = await prisma.order.create({
    data: {
      customerId: customer.id,
      createdByUserId: customer.id,
      pickupPincode: '560001',
      dropPincode: '560002',
      pickupZoneId: southZone.id,
      dropZoneId: southZone.id,
      length: 15,
      breadth: 15,
      height: 15,
      actualWeight: 3.0,
      volumetricWeight: 0.675,
      billableWeight: 3.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
      charge: 120.00, // intra B2C: 40 * 3 = 120
      chargeIsEstimated: false,
      status: OrderStatus.PICKED_UP,
      assignedAgentId: profileBeta.id,
      pendingAssignment: false,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order3.id,
      status: OrderStatus.PLACED,
      actor: 'John Customer',
      actorRole: Role.CUSTOMER,
      notes: 'Order created by customer (self-serve).',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order3.id,
      status: OrderStatus.ASSIGNED,
      actor: 'system',
      actorRole: Role.ADMIN,
      notes: `System auto-assigned agent: Agent Beta`,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order3.id,
      status: OrderStatus.PICKED_UP,
      actor: 'Agent Beta',
      actorRole: Role.AGENT,
      notes: 'Status updated to PICKED_UP',
    },
  });

  // Order 4: DELIVERED by Agent Gamma (pickup West, drop West)
  const order4 = await prisma.order.create({
    data: {
      customerId: customer.id,
      createdByUserId: customer.id,
      pickupPincode: '400001',
      dropPincode: '400002',
      pickupZoneId: westZone.id,
      dropZoneId: westZone.id,
      length: 20,
      breadth: 20,
      height: 20,
      actualWeight: 5.0,
      volumetricWeight: 1.6,
      billableWeight: 5.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
      charge: 200.00, // intra B2C: 40 * 5 = 200
      chargeIsEstimated: false,
      status: OrderStatus.DELIVERED,
      assignedAgentId: profileGamma.id,
      pendingAssignment: false,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order4.id,
      status: OrderStatus.PLACED,
      actor: 'John Customer',
      actorRole: Role.CUSTOMER,
      notes: 'Order created by customer (self-serve).',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order4.id,
      status: OrderStatus.ASSIGNED,
      actor: 'system',
      actorRole: Role.ADMIN,
      notes: `System auto-assigned agent: Agent Gamma`,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order4.id,
      status: OrderStatus.PICKED_UP,
      actor: 'Agent Gamma',
      actorRole: Role.AGENT,
      notes: 'Status updated to PICKED_UP',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order4.id,
      status: OrderStatus.DELIVERED,
      actor: 'Agent Gamma',
      actorRole: Role.AGENT,
      notes: 'Status updated to DELIVERED',
    },
  });

  // Order 5: FAILED (failed shipment, pending reschedule, pickup North, drop North)
  const order5 = await prisma.order.create({
    data: {
      customerId: customer.id,
      createdByUserId: customer.id,
      pickupPincode: '110001',
      dropPincode: '110002',
      pickupZoneId: northZone.id,
      dropZoneId: northZone.id,
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1.0,
      volumetricWeight: 0.2,
      billableWeight: 1.0,
      orderType: OrderType.B2C,
      paymentType: PaymentType.PREPAID,
      charge: 40.00, // intra B2C: 40 * 1 = 40
      chargeIsEstimated: false,
      status: OrderStatus.FAILED,
      assignedAgentId: profileAlpha.id, // was assigned to Agent Alpha before failing
      pendingAssignment: false,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order5.id,
      status: OrderStatus.PLACED,
      actor: 'John Customer',
      actorRole: Role.CUSTOMER,
      notes: 'Order created by customer (self-serve).',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order5.id,
      status: OrderStatus.ASSIGNED,
      actor: 'system',
      actorRole: Role.ADMIN,
      notes: `System auto-assigned agent: Agent Alpha`,
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order5.id,
      status: OrderStatus.PICKED_UP,
      actor: 'Agent Alpha',
      actorRole: Role.AGENT,
      notes: 'Status updated to PICKED_UP',
    },
  });
  await prisma.orderStatusHistory.create({
    data: {
      orderId: order5.id,
      status: OrderStatus.FAILED,
      actor: 'Agent Alpha',
      actorRole: Role.AGENT,
      notes: 'Delivery address closed on lock hours',
    },
  });

  console.log(`- Seeded 5 Sample Orders successfully.`);

  console.log('\n--- COMPREHENSIVE DATABASE SEEDING COMPLETED ---');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
