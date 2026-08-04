import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';

import { authenticateCredentials } from '../auth/credentials';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
} from '../generated/client/client';

function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_TEST_URL is required to run database integration tests.');
  }

  if (new URL(databaseUrl).pathname !== '/skyos_test') {
    throw new Error('DATABASE_TEST_URL must target the dedicated skyos_test database.');
  }

  if (databaseUrl === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must not match DATABASE_URL.');
  }

  return databaseUrl;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: getTestDatabaseUrl() }),
});

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
  );
}

beforeEach(resetTestDatabase);

after(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

test('credentials authenticate active users and bootstrap one organization-owner membership', async () => {
  const email = `developer-${randomUUID()}@skyos.local`;
  const password = 'a-development-password';
  const user = await prisma.user.create({
    data: {
      displayName: 'Development User',
      email,
      identitySubject: `credentials:${randomUUID()}`,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      status: UserStatus.ACTIVE,
    },
  });

  const authenticatedUser = await authenticateCredentials(prisma, { email, password });

  assert.deepEqual(authenticatedUser, {
    email,
    id: user.id,
    image: null,
    name: 'Development User',
  });

  const organizationMemberships = await prisma.organizationMembership.findMany({
    where: { userId: user.id },
    include: { organization: true },
  });

  assert.equal(organizationMemberships.length, 1);
  assert.equal(organizationMemberships[0]?.role, OrganizationRole.OWNER);
  assert.equal(organizationMemberships[0]?.status, MembershipStatus.ACTIVE);
  assert.equal(organizationMemberships[0]?.organization.status, OrganizationStatus.ACTIVE);

  await authenticateCredentials(prisma, { email, password });
  assert.equal(await prisma.organizationMembership.count({ where: { userId: user.id } }), 1);
  assert.equal(await authenticateCredentials(prisma, { email, password: 'incorrect' }), null);

  await prisma.user.update({
    where: { id: user.id },
    data: { status: UserStatus.SUSPENDED },
  });
  assert.equal(await authenticateCredentials(prisma, { email, password }), null);
});
