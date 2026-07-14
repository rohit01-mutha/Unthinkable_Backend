import { PrismaClient, Role } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
  console.log('Admins in DB:', admins.map(a => ({ email: a.email, name: a.name })));
}
main().finally(() => prisma.$disconnect());
