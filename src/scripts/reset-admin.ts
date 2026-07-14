import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Cascade clearing dependencies...');
  await prisma.agentVerificationLog.deleteMany({});
  await prisma.adminAccountRequest.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.agentProfile.deleteMany({});
  
  const deletedCount = await prisma.user.deleteMany({ where: { role: Role.ADMIN } });
  console.log(`Cleared ${deletedCount.count} admin accounts from database.`);

  // Create clean admin user
  const passwordHash = await bcrypt.hash('adminsecret', 10);
  const admin = await prisma.user.create({
    data: {
      email: 'admin_dashboard@test.com',
      name: 'System Administrator',
      phone: '9876543210',
      passwordHash,
      role: Role.ADMIN,
    },
  });
  console.log(`Created new clean admin account: email = ${admin.email}, password = adminsecret`);
}
main().finally(() => prisma.$disconnect());
