import 'dotenv/config';

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { PrismaPg } from '@prisma/adapter-pg';

import { bindGoogleIdentity } from '../auth/google-identity';
import { PrismaClient } from '../generated/client/client';

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for trusted operator identity binding.');
  }

  return databaseUrl;
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Google identity binding requires an interactive trusted operator terminal.');
  }

  const prompt = createInterface({ input: stdin, output: stdout, terminal: true });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDatabaseUrl() }),
  });

  try {
    const actorUserId = await prompt.question('Operator SkyOS User ID: ');
    const targetUserId = await prompt.question('Target SkyOS User ID: ');
    const googleSubject = await prompt.question('Exact Google OIDC subject (sub): ');

    await bindGoogleIdentity(prisma, { actorUserId, googleSubject, targetUserId });
    console.log('Google identity binding completed.');
  } finally {
    prompt.close();
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error('Google identity binding was not completed.');
  process.exitCode = 1;
});
