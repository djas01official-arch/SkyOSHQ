import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/client/client';
import { assertPgvectorAvailable } from '../knowledge/vector-health';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to check pgvector.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const version = await assertPgvectorAvailable(prisma);
    console.log(`PostgreSQL vector extension ${version} is available.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The pgvector check failed.');
  process.exitCode = 1;
});
