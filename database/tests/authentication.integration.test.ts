import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import { authenticateCredentials, normalizeCredentials } from '../auth/credentials';
import { findActiveSessionUser } from '../auth/session-user';
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
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.ORGANIZATION_CREATED, actorUserId: user.id },
    }),
    1,
  );
  assert.equal(await authenticateCredentials(prisma, { email, password: 'incorrect' }), null);

  await prisma.user.update({
    where: { id: user.id },
    data: { status: UserStatus.SUSPENDED },
  });
  assert.equal(await authenticateCredentials(prisma, { email, password }), null);
});

test('credential validation is normalized and rejects malformed input without a lookup', () => {
  assert.deepEqual(
    normalizeCredentials({ email: '  Developer@SkyOS.Local ', password: 'secret' }),
    { email: 'developer@skyos.local', password: 'secret' },
  );
  assert.equal(normalizeCredentials({ email: 'not-an-email', password: 'secret' }), null);
  assert.equal(normalizeCredentials({ email: 'invalid@@skyos.local', password: 'secret' }), null);
  assert.equal(normalizeCredentials({ email: 'user@skyos.local', password: '' }), null);
  assert.equal(
    normalizeCredentials({ email: 'user@skyos.local', password: 'x'.repeat(1025) }),
    null,
  );
});

test('session subjects resolve only active users while preserving the stable user id', async () => {
  const originalEmail = `identity-${randomUUID()}@skyos.local`;
  const updatedEmail = `renamed-${randomUUID()}@skyos.local`;
  const user = await prisma.user.create({
    data: {
      displayName: 'Stable Identity',
      email: originalEmail,
      identitySubject: `credentials:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });

  assert.deepEqual(await findActiveSessionUser(prisma, user.id), {
    displayName: 'Stable Identity',
    email: originalEmail,
    id: user.id,
    image: null,
  });

  await prisma.user.update({ where: { id: user.id }, data: { email: updatedEmail } });
  assert.equal((await findActiveSessionUser(prisma, user.id))?.id, user.id);
  assert.equal((await findActiveSessionUser(prisma, user.id))?.email, updatedEmail);

  await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.SUSPENDED } });
  assert.equal(await findActiveSessionUser(prisma, user.id), null);

  await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.DEACTIVATED } });
  assert.equal(await findActiveSessionUser(prisma, user.id), null);

  await prisma.user.update({
    where: { id: user.id },
    data: { deletedAt: new Date(), status: UserStatus.ACTIVE },
  });
  assert.equal(await findActiveSessionUser(prisma, user.id), null);
});

test('active session subjects do not require a stored email', async () => {
  const user = await prisma.user.create({ data: { status: UserStatus.ACTIVE } });

  assert.deepEqual(await findActiveSessionUser(prisma, user.id), {
    displayName: null,
    email: null,
    id: user.id,
    image: null,
  });
});

test('an external provider identity maps to exactly one internal user', async () => {
  const firstUser = await prisma.user.create({ data: { status: UserStatus.ACTIVE } });
  const secondUser = await prisma.user.create({ data: { status: UserStatus.ACTIVE } });
  const providerAccountId = `subject-${randomUUID()}`;

  await prisma.account.create({
    data: {
      provider: 'test-provider',
      providerAccountId,
      type: 'oidc',
      userId: firstUser.id,
    },
  });

  const account = await prisma.account.findUniqueOrThrow({
    where: {
      provider_providerAccountId: { provider: 'test-provider', providerAccountId },
    },
  });
  assert.equal(account.userId, firstUser.id);

  await assert.rejects(
    prisma.account.create({
      data: {
        provider: 'test-provider',
        providerAccountId,
        type: 'oidc',
        userId: secondUser.id,
      },
    }),
  );
});
