import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// allowExitOnIdle: false — without this the pg pool releases all connections
// after the startup query, draining the Node.js event loop and exiting the server.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle:  false,
});

const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

export default prisma;
