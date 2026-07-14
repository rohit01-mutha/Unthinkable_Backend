import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 4) {
    console.error('Error: Please provide all required arguments.');
    console.log('Usage: npx ts-node src/scripts/seed-admin.ts <email> <name> <phone> <password>');
    process.exit(1);
  }

  const [email, name, phone, password] = args;

  try {
    // Enforce that the first admin account should be seedable only if no admin exists
    const existingAdmin = await prisma.user.findFirst({
      where: { role: Role.ADMIN },
    });

    if (existingAdmin) {
      console.error('Error: An admin account already exists in the database. Seeding is restricted to one-time initialization.');
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const admin = await prisma.user.create({
      data: {
        email,
        name,
        phone,
        passwordHash,
        role: Role.ADMIN,
      },
    });

    console.log('--------------------------------------------------');
    console.log('First Admin Account Seeded Successfully!');
    console.log(`ID:      ${admin.id}`);
    console.log(`Name:    ${admin.name}`);
    console.log(`Email:   ${admin.email}`);
    console.log('--------------------------------------------------');
  } catch (err: any) {
    console.error('Failed to seed admin user:', err.message || err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
