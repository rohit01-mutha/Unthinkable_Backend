import { Request, Response } from 'express';
import { PrismaClient, OrderType } from '@prisma/client';

const prisma = new PrismaClient();

// Upsert Rate Card (Admin configurable pricing parameters)
export const upsertRateCard = async (req: Request, res: Response) => {
  const { orderType, intraZoneRate, interZoneRate, codSurcharge } = req.body;

  if (!orderType || !Object.values(OrderType).includes(orderType)) {
    return res.status(400).json({ error: 'Valid orderType (B2B or B2C) is required' });
  }

  if (
    intraZoneRate === undefined ||
    interZoneRate === undefined ||
    codSurcharge === undefined
  ) {
    return res.status(400).json({
      error: 'intraZoneRate, interZoneRate, and codSurcharge are all required',
    });
  }

  const parseRate = (val: any) => parseFloat(val);
  const intraRate = parseRate(intraZoneRate);
  const interRate = parseRate(interZoneRate);
  const codSurg = parseRate(codSurcharge);

  if (isNaN(intraRate) || isNaN(interRate) || isNaN(codSurg)) {
    return res.status(400).json({ error: 'Pricing rates must be valid numbers' });
  }

  try {
    const rateCard = await prisma.rateCard.upsert({
      where: { orderType },
      update: {
        intraZoneRate: intraRate,
        interZoneRate: interRate,
        codSurcharge: codSurg,
      },
      create: {
        orderType,
        intraZoneRate: intraRate,
        interZoneRate: interRate,
        codSurcharge: codSurg,
      },
    });

    return res.status(200).json({
      message: 'Rate card updated successfully',
      rateCard,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update rate card' });
  }
};

// List all Rate Cards
export const listRateCards = async (req: Request, res: Response) => {
  try {
    const rateCards = await prisma.rateCard.findMany({
      orderBy: { orderType: 'asc' },
    });
    return res.status(200).json(rateCards);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to retrieve rate cards' });
  }
};
