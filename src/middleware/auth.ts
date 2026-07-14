import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: Role;
  };
}

export const authenticateJWT = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or invalid' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const jwtSecret = process.env.JWT_SECRET || 'scaffolding_secret_key';
    const decoded = jwt.verify(token, jwtSecret) as { id: string; email: string; role: Role };

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { agentProfile: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // If the user is an AGENT, ensure their verificationStatus is APPROVED
    if (user.role === 'AGENT') {
      if (!user.agentProfile || user.agentProfile.verificationStatus !== 'APPROVED') {
        const status = user.agentProfile?.verificationStatus?.toLowerCase() || 'pending';
        return res.status(403).json({
          error: `Agent account is ${status}. Access is restricted until approved by an admin.`,
          status: user.agentProfile?.verificationStatus || 'PENDING'
        });
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const requireRole = (roles: Role[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    next();
  };
};
