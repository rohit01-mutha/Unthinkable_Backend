import { PrismaClient, OrderType, PaymentType } from '@prisma/client';
import { calculateCharge } from '../src/services/pricingService';

const prisma = new PrismaClient();

describe('Mission 4: Rate Calculation Engine Unit Tests', () => {
  jest.setTimeout(30000);

  let northZoneId: string;
  let southZoneId: string;

  beforeAll(async () => {
    // 1. Clear database tables
    await prisma.agentVerificationLog.deleteMany({});
    await prisma.agentProfile.deleteMany({});
    await prisma.orderStatusHistory.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.adminAccountRequest.deleteMany({});
    await prisma.zoneArea.deleteMany({});
    await prisma.zone.deleteMany({});
    await prisma.rateCard.deleteMany({});
    await prisma.user.deleteMany({});

    // 2. Seed Zones
    const northZone = await prisma.zone.create({ data: { name: 'North Zone' } });
    const southZone = await prisma.zone.create({ data: { name: 'South Zone' } });
    northZoneId = northZone.id;
    southZoneId = southZone.id;

    // 3. Seed Mappings
    await prisma.zoneArea.create({ data: { pincode: '110001', zoneId: northZoneId } });
    await prisma.zoneArea.create({ data: { pincode: '110002', zoneId: northZoneId } });
    await prisma.zoneArea.create({ data: { pincode: '560001', zoneId: southZoneId } });

    // 4. Seed Rate Cards
    // B2B: Intra = 50.0, Inter = 100.0, COD Surcharge = 15.0
    await prisma.rateCard.create({
      data: {
        orderType: OrderType.B2B,
        intraZoneRate: 50.0,
        interZoneRate: 100.0,
        codSurcharge: 15.0,
      },
    });

    // B2C: Intra = 40.0, Inter = 80.0, COD Surcharge = 10.0
    await prisma.rateCard.create({
      data: {
        orderType: OrderType.B2C,
        intraZoneRate: 40.0,
        interZoneRate: 80.0,
        codSurcharge: 10.0,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test 1: Intra-zone vs Inter-zone rate applied
  test('1. Applies intra-zone rate for same zone, inter-zone rate for different zones', async () => {
    // Intra-zone check (110001 to 110002) - B2B
    const intraRes = await calculateCharge({
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1, // Volumetric = 1000/5000 = 0.2, Billable = 1.0
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    });

    expect(intraRes.zoneRelation).toBe('intra');
    expect(intraRes.rateApplied).toBe(50.0);
    expect(intraRes.totalCharge).toBe(50.0 * 1.0);

    // Inter-zone check (110001 to 560001) - B2B
    const interRes = await calculateCharge({
      pickupPincode: '110001',
      dropPincode: '560001',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1, // Billable = 1.0
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    });

    expect(interRes.zoneRelation).toBe('inter');
    expect(interRes.rateApplied).toBe(100.0);
    expect(interRes.totalCharge).toBe(100.0 * 1.0);
  });

  // Test 2: Weight comparisons
  test('2. Compares actual weight vs volumetric weight and bills on higher value', async () => {
    // Case A: Actual Weight is higher (10kg vs Volumetric 0.4kg)
    const actualHigherRes = await calculateCharge({
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 20, // Volumetric = 2000/5000 = 0.4kg
      actualWeight: 10, // Billable = 10
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    });

    expect(actualHigherRes.volumetricWeight).toBe(0.4);
    expect(actualHigherRes.billableWeight).toBe(10);
    expect(actualHigherRes.totalCharge).toBe(50.0 * 10);

    // Case B: Volumetric Weight is higher (1.0kg vs Volumetric 5.0kg)
    const volumetricHigherRes = await calculateCharge({
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 50,
      breadth: 50,
      height: 10, // Volumetric = 25000/5000 = 5.0kg
      actualWeight: 1.0, // Billable = 5.0
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    });

    expect(volumetricHigherRes.volumetricWeight).toBe(5.0);
    expect(volumetricHigherRes.billableWeight).toBe(5.0);
    expect(volumetricHigherRes.totalCharge).toBe(50.0 * 5.0);
  });

  // Test 3: B2B vs B2C rates
  test('3. Correctly applies pricing parameters based on orderType (B2B vs B2C)', async () => {
    const params = {
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 2, // Billable = 2
      paymentType: PaymentType.PREPAID,
    };

    // B2B calculation: Rate should be 50.0
    const b2bRes = await calculateCharge({ ...params, orderType: OrderType.B2B });
    expect(b2bRes.rateApplied).toBe(50.0);
    expect(b2bRes.totalCharge).toBe(50.0 * 2);

    // B2C calculation: Rate should be 40.0
    const b2cRes = await calculateCharge({ ...params, orderType: OrderType.B2C });
    expect(b2cRes.rateApplied).toBe(40.0);
    expect(b2cRes.totalCharge).toBe(40.0 * 2);
  });

  // Test 4: COD surcharge checks
  test('4. Applies COD surcharge correctly on COD orders and omits it on Prepaid', async () => {
    const params = {
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1, // Billable = 1
      orderType: OrderType.B2C,
    };

    // COD order: should add 10.0 surcharge (B2C)
    const codRes = await calculateCharge({ ...params, paymentType: PaymentType.COD });
    expect(codRes.codSurcharge).toBe(10.0);
    expect(codRes.totalCharge).toBe(40.0 * 1.0 + 10.0); // 50.0

    // PREPAID order: should add 0.0 surcharge
    const prepaidRes = await calculateCharge({ ...params, paymentType: PaymentType.PREPAID });
    expect(prepaidRes.codSurcharge).toBe(0.0);
    expect(prepaidRes.totalCharge).toBe(40.0 * 1.0); // 40.0
  });

  // Test 5: Error on unmapped pincodes
  test('5. Throws a clear error if the pickup or drop pincode is not mapped to any zone', async () => {
    const validParams = {
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1,
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    };

    // Unmapped pickup
    await expect(
      calculateCharge({
        ...validParams,
        pickupPincode: '999999', // Not mapped
        dropPincode: '110002',
      })
    ).rejects.toThrow('is not mapped to any shipping zone');

    // Unmapped drop
    await expect(
      calculateCharge({
        ...validParams,
        pickupPincode: '110001',
        dropPincode: '999999', // Not mapped
      })
    ).rejects.toThrow('is not mapped to any shipping zone');
  });

  // Test 6: Error on missing rate card
  test('6. Throws a clear error if the rate card for the orderType is missing', async () => {
    // Delete B2B Rate Card temporarily
    await prisma.rateCard.delete({ where: { orderType: OrderType.B2B } });

    const params = {
      pickupPincode: '110001',
      dropPincode: '110002',
      length: 10,
      breadth: 10,
      height: 10,
      actualWeight: 1,
      orderType: OrderType.B2B,
      paymentType: PaymentType.PREPAID,
    };

    await expect(calculateCharge(params)).rejects.toThrow('Rate card configuration missing');
  });
});
