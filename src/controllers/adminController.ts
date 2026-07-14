import { Response } from 'express';
import { PrismaClient, VerificationStatus, AgentVerificationAction } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';

const prisma = new PrismaClient();

// List all agent profiles (including pending/rejected for verification dashboard)
export const listAllAgents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const agents = await prisma.agentProfile.findMany({
      include: {
        user: { select: { name: true, email: true, phone: true } },
        currentZone: { select: { name: true } },
      },
      orderBy: { user: { name: 'asc' } },
    });
    return res.status(200).json(agents);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to list agents' });
  }
};

// Verify/approve/reject an agent profile
export const verifyAgent = async (req: AuthenticatedRequest, res: Response) => {
  const { profileId } = req.params;
  const { action, notes } = req.body;
  const adminId = req.user?.id;

  if (!profileId) {
    return res.status(400).json({ error: 'Profile ID is required' });
  }

  if (!action || !Object.values(VerificationStatus).includes(action)) {
    return res.status(400).json({
      error: 'Invalid action. Action must be APPROVED or REJECTED.',
    });
  }

  if (!adminId) {
    return res.status(401).json({ error: 'Admin credentials not found' });
  }

  try {
    const profile = await prisma.agentProfile.findUnique({
      where: { id: profileId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Agent profile not found' });
    }

    const mappingAction =
      action === VerificationStatus.APPROVED
        ? AgentVerificationAction.APPROVED
        : AgentVerificationAction.REJECTED;

    const result = await prisma.$transaction(async (tx) => {
      // Update Agent Profile verificationStatus
      const updatedProfile = await tx.agentProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: action as VerificationStatus,
        },
      });

      // Append verification audit log
      await tx.agentVerificationLog.create({
        data: {
          agentProfileId: profileId,
          action: mappingAction,
          actedByUserId: adminId,
          notes: notes || `Agent verification ${action.toLowerCase()} by Admin.`,
        },
      });

      return updatedProfile;
    });

    return res.status(200).json({
      message: `Agent profile has been ${action.toLowerCase()} successfully.`,
      profile: result,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Verification failed' });
  }
};
