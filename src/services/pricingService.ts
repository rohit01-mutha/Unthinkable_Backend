import { PrismaClient, OrderType, PaymentType } from '@prisma/client';

const prisma = new PrismaClient();

interface CalculateChargeParams {
  pickupPincode: string;
  dropPincode: string;
  length: number;
  breadth: number;
  height: number;
  actualWeight: number;
  orderType: OrderType;
  paymentType: PaymentType;
}

export interface PricingBreakdown {
  pickupZone: string;
  dropZone: string;
  pickupZoneId: string;
  dropZoneId: string;
  zoneRelation: 'intra' | 'inter';
  volumetricWeight: number;
  billableWeight: number;
  rateApplied: number;
  codSurcharge: number;
  totalCharge: number;
}

/**
 * Calculates shipping charges based on package dimension, weight, zone configuration,
 * and order/payment parameters. No pricing rates are hardcoded.
 */
export const calculateCharge = async (params: CalculateChargeParams): Promise<PricingBreakdown> => {
  const {
    pickupPincode,
    dropPincode,
    length,
    breadth,
    height,
    actualWeight,
    orderType,
    paymentType,
  } = params;

  // 1. Look up pickup zone from ZoneArea mapping
  const pickupArea = await prisma.zoneArea.findUnique({
    where: { pincode: pickupPincode },
    include: { zone: true },
  });

  if (!pickupArea) {
    throw new Error(`Pincode ${pickupPincode} (pickup) is not mapped to any shipping zone.`);
  }

  // 1. Look up drop zone from ZoneArea mapping
  const dropArea = await prisma.zoneArea.findUnique({
    where: { pincode: dropPincode },
    include: { zone: true },
  });

  if (!dropArea) {
    throw new Error(`Pincode ${dropPincode} (drop) is not mapped to any shipping zone.`);
  }

  const pickupZoneName = pickupArea.zone.name;
  const dropZoneName = dropArea.zone.name;
  const pickupZoneId = pickupArea.zoneId;
  const dropZoneId = dropArea.zoneId;

  // 2. volumetricWeight = (L * B * H) / 5000
  const volumetricWeight = (length * breadth * height) / 5000;

  // 3. billableWeight = max(actualWeight, volumetricWeight)
  const billableWeight = Math.max(actualWeight, volumetricWeight);

  // 4. zoneRelation = pickupZone === dropZone ? 'intra' : 'inter'
  const zoneRelation = pickupZoneId === dropZoneId ? 'intra' : 'inter';

  // 5. Look up the rate from RateCard for the given orderType
  const rateCard = await prisma.rateCard.findUnique({
    where: { orderType },
  });

  if (!rateCard) {
    throw new Error(`Rate card configuration missing for order type: ${orderType}`);
  }

  // Apply the correct rate based on the zone relation
  const rateApplied = zoneRelation === 'intra' ? rateCard.intraZoneRate : rateCard.interZoneRate;

  // 6. charge = rate * billableWeight
  const baseCharge = rateApplied * billableWeight;

  // 7. If paymentType is COD, add RateCard.codSurcharge for that orderType
  const codSurcharge = paymentType === PaymentType.COD ? rateCard.codSurcharge : 0.0;

  // Calculate totalCharge
  const totalCharge = baseCharge + codSurcharge;

  return {
    pickupZone: pickupZoneName,
    dropZone: dropZoneName,
    pickupZoneId,
    dropZoneId,
    zoneRelation,
    volumetricWeight,
    billableWeight,
    rateApplied,
    codSurcharge,
    totalCharge,
  };
};
