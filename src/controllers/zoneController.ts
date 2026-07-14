import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Create Zone
export const createZone = async (req: Request, res: Response) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Zone name is required' });
  }

  try {
    const existingZone = await prisma.zone.findUnique({ where: { name } });
    if (existingZone) {
      return res.status(400).json({ error: 'Zone with this name already exists' });
    }

    const zone = await prisma.zone.create({
      data: { name },
    });

    return res.status(201).json({
      message: 'Zone created successfully',
      zone,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to create zone' });
  }
};

// List Zones
export const listZones = async (req: Request, res: Response) => {
  try {
    const zones = await prisma.zone.findMany({
      include: {
        _count: {
          select: { areas: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    return res.status(200).json(zones);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to retrieve zones' });
  }
};

// Delete Zone
export const deleteZone = async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: 'Zone ID is required' });
  }

  try {
    const zone = await prisma.zone.findUnique({ where: { id } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    await prisma.zone.delete({ where: { id } });

    return res.status(200).json({
      message: 'Zone and all its pincode mappings deleted successfully',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete zone' });
  }
};

// Create Zone Area Mapping (Map Pincode to Zone)
export const createZoneArea = async (req: Request, res: Response) => {
  const { pincode, zoneId } = req.body;

  if (!pincode || !zoneId) {
    return res.status(400).json({ error: 'Pincode and zoneId are required' });
  }

  try {
    // Verify zone exists
    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(404).json({ error: 'Target zone not found' });
    }

    // Upsert the pincode mapping (since pincode is primary key in ZoneArea)
    const area = await prisma.zoneArea.upsert({
      where: { pincode },
      update: { zoneId },
      create: { pincode, zoneId },
    });

    return res.status(201).json({
      message: 'Pincode mapped to zone successfully',
      area,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to map pincode' });
  }
};

// List Zone Area Mappings
export const listZoneAreas = async (req: Request, res: Response) => {
  try {
    const areas = await prisma.zoneArea.findMany({
      include: {
        zone: {
          select: { name: true },
        },
      },
      orderBy: { pincode: 'asc' },
    });
    return res.status(200).json(areas);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to retrieve mappings' });
  }
};

// Delete Zone Area Mapping
export const deleteZoneArea = async (req: Request, res: Response) => {
  const { pincode } = req.params;

  if (!pincode) {
    return res.status(400).json({ error: 'Pincode is required' });
  }

  try {
    const area = await prisma.zoneArea.findUnique({ where: { pincode } });
    if (!area) {
      return res.status(404).json({ error: 'Pincode mapping not found' });
    }

    await prisma.zoneArea.delete({ where: { pincode } });

    return res.status(200).json({
      message: 'Pincode mapping deleted successfully',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete mapping' });
  }
};
