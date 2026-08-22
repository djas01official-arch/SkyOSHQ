import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  admitPreProvisionedGoogleIdentity,
  bindGoogleIdentity,
  GoogleIdentityBindingConflictError,
  GoogleIdentityBindingError,
  recordGoogleIdentitySignInSuccess,
} from '../auth/google-identity';
import { IdentityAuditAction } from '../auth/identity-audit';
import { PrismaClient, UserStatus } from '../generated/client/client';

function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl || new URL(databaseUrl).pathname !== '/skyos_test') {
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

async function createUser(input: Partial<{ email: string; status: UserStatus }> = {}) {
  return prisma.user.create({
    data: {
      email: input.email,
      identitySubject: `google-identity-test:${randomUUID()}`,
      status: input.status ?? UserStatus.ACTIVE,
    },
  });
}

function googleIdentity(subject = `google-subject-${randomUUID()}`) {
  return {
    account: { provider: 'google', providerAccountId: subject, type: 'oidc' },
    profile: { email: `identity-${randomUUID()}@example.test`, email_verified: true, sub: subject },
  };
}

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "identity_audit_events", "audit_events", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
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

test('only an exact active pre-provisioned Google subject passes admission without creating identity rows', async () => {
  const operator = await createUser();
  const target = await createUser({ email: `target-${randomUUID()}@example.test` });
  const identity = googleIdentity();
  const binding = await bindGoogleIdentity(prisma, {
    actorUserId: operator.id,
    googleSubject: identity.profile.sub,
    targetUserId: target.id,
  });
  const usersBefore = await prisma.user.count();
  const accountsBefore = await prisma.account.count();

  assert.deepEqual(await admitPreProvisionedGoogleIdentity(prisma, identity), {
    allowed: true,
    userId: target.id,
  });
  assert.equal(await prisma.user.count(), usersBefore);
  assert.equal(await prisma.account.count(), accountsBefore);
  assert.equal(
    (await prisma.account.findUniqueOrThrow({ where: { id: binding.accountId } })).userId,
    target.id,
  );
});

test('unknown Google subjects and email-only matches are rejected without User or Account persistence', async () => {
  const preexisting = await createUser({ email: `same-email-${randomUUID()}@example.test` });
  const identity = googleIdentity();
  const usersBefore = await prisma.user.count();
  const accountsBefore = await prisma.account.count();

  identity.profile.email = preexisting.email!;
  assert.deepEqual(await admitPreProvisionedGoogleIdentity(prisma, identity), {
    allowed: false,
    reason: 'unknown',
  });
  assert.equal(await prisma.user.count(), usersBefore);
  assert.equal(await prisma.account.count(), accountsBefore);

  const audit = await prisma.identityAuditEvent.findFirstOrThrow({
    where: { action: IdentityAuditAction.GOOGLE_SIGN_IN_REJECTED_UNKNOWN },
  });
  assert.equal(audit.provider, 'google');
  assert.notEqual(audit.subjectFingerprint, identity.profile.sub);
  assert.deepEqual(audit.metadata, { reason: 'unknown_google_subject' });
});

test('invalid Google profile/account shapes fail closed before lookup and are auditable without raw identity data', async () => {
  const invalid = googleIdentity();
  invalid.account.providerAccountId = 'different-subject';

  assert.deepEqual(await admitPreProvisionedGoogleIdentity(prisma, invalid), {
    allowed: false,
    reason: 'invalid',
  });
  assert.equal(await prisma.account.count(), 0);
  assert.equal(await prisma.user.count(), 0);
  const audit = await prisma.identityAuditEvent.findFirstOrThrow({
    where: { action: IdentityAuditAction.GOOGLE_SIGN_IN_REJECTED_INVALID },
  });
  assert.equal(audit.subjectFingerprint.length, 64);
  assert.deepEqual(audit.metadata, { reason: 'invalid_google_identity' });
});

test('suspended, deactivated, and deleted bound users cannot pass Google admission', async () => {
  for (const state of [UserStatus.SUSPENDED, UserStatus.DEACTIVATED] as const) {
    await resetTestDatabase();
    const operator = await createUser();
    const target = await createUser();
    const identity = googleIdentity();
    await bindGoogleIdentity(prisma, {
      actorUserId: operator.id,
      googleSubject: identity.profile.sub,
      targetUserId: target.id,
    });
    await prisma.user.update({ where: { id: target.id }, data: { status: state } });
    assert.deepEqual(await admitPreProvisionedGoogleIdentity(prisma, identity), {
      allowed: false,
      reason: 'inactive',
    });
  }

  await resetTestDatabase();
  const operator = await createUser();
  const target = await createUser();
  const identity = googleIdentity();
  await bindGoogleIdentity(prisma, {
    actorUserId: operator.id,
    googleSubject: identity.profile.sub,
    targetUserId: target.id,
  });
  await prisma.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
  assert.deepEqual(await admitPreProvisionedGoogleIdentity(prisma, identity), {
    allowed: false,
    reason: 'inactive',
  });
});

test('operator binding is exact-subject only, token-free, idempotent, and conflict-safe', async () => {
  const operator = await createUser();
  const target = await createUser();
  const otherTarget = await createUser();
  const subject = `google-subject-${randomUUID()}`;

  const first = await bindGoogleIdentity(prisma, {
    actorUserId: operator.id,
    googleSubject: subject,
    targetUserId: target.id,
  });
  const account = await prisma.account.findUniqueOrThrow({ where: { id: first.accountId } });
  assert.equal(first.outcome, 'created');
  assert.equal(account.provider, 'google');
  assert.equal(account.providerAccountId, subject);
  assert.equal(account.type, 'oidc');
  assert.equal(account.access_token, null);
  assert.equal(account.refresh_token, null);
  assert.equal(account.id_token, null);

  const repeated = await bindGoogleIdentity(prisma, {
    actorUserId: operator.id,
    googleSubject: subject,
    targetUserId: target.id,
  });
  assert.deepEqual(repeated, { accountId: first.accountId, outcome: 'observed' });
  assert.equal(await prisma.account.count(), 1);

  await assert.rejects(
    bindGoogleIdentity(prisma, {
      actorUserId: operator.id,
      googleSubject: subject,
      targetUserId: otherTarget.id,
    }),
    GoogleIdentityBindingConflictError,
  );
  assert.equal(await prisma.account.count(), 1);
  assert.equal(
    await prisma.identityAuditEvent.count({
      where: { action: IdentityAuditAction.GOOGLE_BINDING_CONFLICT_REJECTED },
    }),
    1,
  );
});

test('operator binding rejects nonexistent, suspended, deactivated, and deleted users', async () => {
  const active = await createUser();
  const suspended = await createUser({ status: UserStatus.SUSPENDED });
  const deactivated = await createUser({ status: UserStatus.DEACTIVATED });
  const deleted = await createUser();
  await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

  for (const targetUserId of [randomUUID(), suspended.id, deactivated.id, deleted.id]) {
    await assert.rejects(
      bindGoogleIdentity(prisma, {
        actorUserId: active.id,
        googleSubject: `google-subject-${randomUUID()}`,
        targetUserId,
      }),
      GoogleIdentityBindingError,
    );
  }
  await assert.rejects(
    bindGoogleIdentity(prisma, {
      actorUserId: suspended.id,
      googleSubject: `google-subject-${randomUUID()}`,
      targetUserId: active.id,
    }),
    GoogleIdentityBindingError,
  );
  assert.equal(await prisma.account.count(), 0);
});

test('successful external Google sign-in audit is redacted and identity audit history is append-only', async () => {
  const operator = await createUser();
  const target = await createUser();
  const identity = googleIdentity();
  await bindGoogleIdentity(prisma, {
    actorUserId: operator.id,
    googleSubject: identity.profile.sub,
    targetUserId: target.id,
  });

  await recordGoogleIdentitySignInSuccess(prisma, {
    account: identity.account,
    profile: identity.profile,
    userId: target.id,
  });
  const audit = await prisma.identityAuditEvent.findFirstOrThrow({
    where: { action: IdentityAuditAction.GOOGLE_SIGN_IN_SUCCEEDED },
  });
  assert.equal(audit.actorUserId, target.id);
  assert.equal(audit.targetUserId, target.id);
  assert.deepEqual(audit.metadata, {});
  assert.notEqual(audit.subjectFingerprint, identity.profile.sub);
  await assert.rejects(
    prisma.identityAuditEvent.update({ where: { id: audit.id }, data: { action: 'changed' } }),
    /append-only/u,
  );
  await assert.rejects(
    prisma.identityAuditEvent.delete({ where: { id: audit.id } }),
    /append-only/u,
  );
});
