import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient, Role, VerificationStatus, AgentVerificationAction } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'scaffolding_secret_key';

export const customerSignup = async (req: Request, res: Response) => {
  const { email, name, phone, password } = req.body;

  if (!email || !name || !phone || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        name,
        phone,
        passwordHash,
        role: Role.CUSTOMER,
      },
    });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
      expiresIn: '24h',
    });

    return res.status(201).json({
      message: 'Customer signup successful',
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Signup failed' });
  }
};

export const agentSignup = async (req: Request, res: Response) => {
  const { email, name, phone, password, vehicleType, kycDocUrl } = req.body;

  if (!email || !name || !phone || !password || !vehicleType || !kycDocUrl) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Create user and agent profile in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name,
          phone,
          passwordHash,
          role: Role.AGENT,
        },
      });

      const profile = await tx.agentProfile.create({
        data: {
          userId: user.id,
          verificationStatus: VerificationStatus.PENDING,
          vehicleType,
          kycDocUrl,
        },
      });

      await tx.agentVerificationLog.create({
        data: {
          agentProfileId: profile.id,
          action: AgentVerificationAction.SUBMITTED,
          actedByUserId: user.id, // Agent acted on their own onboarding
          notes: 'Agent onboarding submission',
        },
      });

      return { user, profile };
    });

    return res.status(201).json({
      message: 'Agent signup successful. Account is pending admin verification.',
      userId: result.user.id,
      profileId: result.profile.id,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Agent signup failed' });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { agentProfile: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Role-based onboarding restriction for agents
    if (user.role === Role.AGENT) {
      if (!user.agentProfile || user.agentProfile.verificationStatus !== VerificationStatus.APPROVED) {
        const status = user.agentProfile?.verificationStatus || VerificationStatus.PENDING;
        if (status === VerificationStatus.PENDING) {
          return res.status(403).json({
            error: 'Your agent account is pending verification. Please contact an admin.',
            status: 'PENDING',
          });
        } else if (status === VerificationStatus.REJECTED) {
          return res.status(403).json({
            error: 'Your agent account verification has been rejected.',
            status: 'REJECTED',
          });
        }
      }
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
      expiresIn: '24h',
    });

    return res.status(200).json({
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Login failed' });
  }
};

export const proposeAdmin = async (req: AuthenticatedRequest, res: Response) => {
  const { proposedEmail } = req.body;
  const adminId = req.user?.id;

  if (!proposedEmail) {
    return res.status(400).json({ error: 'Email to propose is required' });
  }

  if (!adminId) {
    return res.status(401).json({ error: 'Admin action requires active login context' });
  }

  try {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email: proposedEmail } });
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    // Check if there is an active/pending request
    const existingRequest = await prisma.adminAccountRequest.findUnique({
      where: { proposedEmail },
    });
    if (existingRequest && existingRequest.status === VerificationStatus.PENDING) {
      return res.status(400).json({ error: 'An admin request for this email is already pending' });
    }

    const request = await prisma.adminAccountRequest.create({
      data: {
        proposedEmail,
        proposedByAdminId: adminId,
        status: VerificationStatus.PENDING,
      },
    });

    return res.status(201).json({
      message: 'Admin account proposal created',
      request,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Proposal failed' });
  }
};

export const approveAdmin = async (req: AuthenticatedRequest, res: Response) => {
  const { requestId } = req.body;
  const currentAdminId = req.user?.id;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID is required' });
  }

  if (!currentAdminId) {
    return res.status(401).json({ error: 'Admin action requires active login context' });
  }

  try {
    const request = await prisma.adminAccountRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      return res.status(404).json({ error: 'Admin request not found' });
    }

    if (request.status !== VerificationStatus.PENDING) {
      return res.status(400).json({ error: 'Request has already been processed' });
    }

    // Maker-checker rule enforcement at database/service layer
    if (request.proposedByAdminId === currentAdminId) {
      return res.status(400).json({
        error: 'Maker-checker policy violation: Proposing admin cannot approve their own request.',
      });
    }

    // Update request status and approve it
    const updatedRequest = await prisma.adminAccountRequest.update({
      where: { id: requestId },
      data: {
        status: VerificationStatus.APPROVED,
        approvedByAdminId: currentAdminId,
      },
    });

    // Generate invite signup token containing the email and requestId
    const inviteToken = jwt.sign(
      { email: request.proposedEmail, requestId: request.id },
      JWT_SECRET,
      { expiresIn: '72h' } // Token valid for 3 days
    );

    return res.status(200).json({
      message: 'Admin account proposal approved successfully.',
      inviteToken,
      request: updatedRequest,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Approval failed' });
  }
};

export const adminSignup = async (req: Request, res: Response) => {
  const { token, name, phone, password } = req.body;

  if (!token || !name || !phone || !password) {
    return res.status(400).json({ error: 'All fields (token, name, phone, password) are required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string; requestId: string };

    const request = await prisma.adminAccountRequest.findUnique({
      where: { id: decoded.requestId },
    });

    if (!request || request.status !== VerificationStatus.APPROVED) {
      return res.status(400).json({ error: 'Invalid invitation request status' });
    }

    // Check if email matches and user doesn't already exist
    if (request.proposedEmail !== decoded.email) {
      return res.status(400).json({ error: 'Token email mismatch' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: decoded.email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Admin account has already been registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: decoded.email,
        name,
        phone,
        passwordHash,
        role: Role.ADMIN,
      },
    });

    return res.status(201).json({
      message: 'Admin account created successfully.',
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Admin invitation redemption failed' });
  }
};

// List all admin requests (for Admin dashboard checker interface)
export const listAdminRequests = async (req: AuthenticatedRequest, res: Response) => {
  const currentAdminId = req.user?.id;

  if (!currentAdminId) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  try {
    const requests = await prisma.adminAccountRequest.findMany({
      include: {
        proposedByAdmin: { select: { id: true, name: true, email: true } },
        approvedByAdmin: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.status(200).json(requests);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to list admin requests' });
  }
};
