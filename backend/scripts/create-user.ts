/**
 * Usage: npx tsx scripts/create-user.ts --email user@example.com --name "User Name" --password "secret" [--role admin]
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const email    = getArg('--email');
const name     = getArg('--name');
const password = getArg('--password');
const role     = getArg('--role') ?? 'user';

if (!email || !name || !password) {
  console.error('Usage: npx tsx scripts/create-user.ts --email EMAIL --name "NAME" --password PASSWORD [--role admin|user]');
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);

try {
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase().trim() },
    update: { name, passwordHash, role },
    create: { email: email.toLowerCase().trim(), name, passwordHash, role },
  });
  console.log(`✓ User created/updated: ${user.email} (id=${user.id}, role=${user.role})`);
} catch (err: any) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
