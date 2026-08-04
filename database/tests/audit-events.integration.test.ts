import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import { createWorkspaceForOrganization } from '../context/workspace-creation';
import {
  archiveOrganization,
  archiveWorkspace,
  changeOrganizationMembershipRole,
  changeWorkspaceMembershipRole,
  restoreOrganization,
  restoreWorkspace,
  resumeOrganizationMembership,
  resumeWorkspaceMembership,
  revokeOrganizationMembership,
  revokeWorkspaceMembership,
  suspendOrganizationMembership,
  suspendWorkspaceMembership,
  transferOrganizationOwnership,
  transferWorkspaceOwnership,
} from '../operations/privileged-operations';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';

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

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { identitySubject: `test:${randomUUID()}`, status: UserStatus.ACTIVE },
  });

  return user.id;
}

async function createOrganization(ownerId: string): Promise<string> {
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: ownerId,
      name: `Organization ${randomUUID()}`,
      slug: `organization-${randomUUID()}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerId,
    },
  });

  return organization.id;
}

async function addOrganizationMember(
  organizationId: string,
  userId: string,
  role: OrganizationRole = OrganizationRole.MEMBER,
) {
  return prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role,
      status: MembershipStatus.ACTIVE,
      userId,
    },
  });
}

async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = WorkspaceRole.MEMBER,
) {
  return prisma.workspaceMembership.create({
    data: { activatedAt: new Date(), role, status: MembershipStatus.ACTIVE, userId, workspaceId },
  });
}

async function resetTestDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_events", "workspace_memberships", "organization_memberships", "workspaces", "organizations", "users" CASCADE;',
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

test('workspace creation writes a complete audit event', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);

  const workspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
    'Audited Workspace',
  );
  const event = await prisma.auditEvent.findFirstOrThrow({
    where: { action: AuditAction.WORKSPACE_CREATED, targetId: workspace.id },
  });

  assert.equal(event.actorUserId, ownerId);
  assert.equal(event.organizationId, organizationId);
  assert.equal(event.workspaceId, workspace.id);
  assert.equal(event.targetType, 'workspace');
  assert.deepEqual(event.metadata, { name: workspace.name, slug: workspace.slug });
  assert.ok(event.createdAt instanceof Date);
});

test('privileged organization and workspace operations emit audit events', async () => {
  const firstOwnerId = await createUser();
  const successorId = await createUser();
  const lifecycleMemberId = await createUser();
  const organizationId = await createOrganization(firstOwnerId);
  const successorOrganizationMembership = await addOrganizationMember(organizationId, successorId);
  const lifecycleOrganizationMembership = await addOrganizationMember(
    organizationId,
    lifecycleMemberId,
  );
  const workspace = await createWorkspaceForOrganization(
    prisma,
    firstOwnerId,
    organizationId,
    'Operations',
  );
  const firstOwnerWorkspaceMembership = await prisma.workspaceMembership.findUniqueOrThrow({
    where: { workspaceId_userId: { userId: firstOwnerId, workspaceId: workspace.id } },
  });
  const successorWorkspaceMembership = await addWorkspaceMember(workspace.id, successorId);
  const lifecycleWorkspaceMembership = await addWorkspaceMember(workspace.id, lifecycleMemberId);

  await changeOrganizationMembershipRole(
    prisma,
    firstOwnerId,
    successorOrganizationMembership.id,
    OrganizationRole.ADMIN,
  );
  await changeWorkspaceMembershipRole(
    prisma,
    firstOwnerId,
    successorWorkspaceMembership.id,
    WorkspaceRole.ADMIN,
  );
  await suspendWorkspaceMembership(prisma, firstOwnerId, lifecycleWorkspaceMembership.id);
  await resumeWorkspaceMembership(prisma, firstOwnerId, lifecycleWorkspaceMembership.id);
  await revokeWorkspaceMembership(prisma, firstOwnerId, lifecycleWorkspaceMembership.id);
  await suspendOrganizationMembership(prisma, firstOwnerId, lifecycleOrganizationMembership.id);
  await resumeOrganizationMembership(prisma, firstOwnerId, lifecycleOrganizationMembership.id);
  await revokeOrganizationMembership(prisma, firstOwnerId, lifecycleOrganizationMembership.id);
  await transferOrganizationOwnership(
    prisma,
    firstOwnerId,
    (
      await prisma.organizationMembership.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId, userId: firstOwnerId } },
      })
    ).id,
    successorOrganizationMembership.id,
  );
  await transferWorkspaceOwnership(
    prisma,
    firstOwnerId,
    firstOwnerWorkspaceMembership.id,
    successorWorkspaceMembership.id,
  );
  await archiveWorkspace(prisma, successorId, workspace.id);
  await restoreWorkspace(prisma, successorId, workspace.id);
  await archiveOrganization(prisma, successorId, organizationId);
  await restoreOrganization(prisma, successorId, organizationId);

  const actions = new Set(
    (await prisma.auditEvent.findMany({ select: { action: true } })).map((event) => event.action),
  );
  const expectedActions = [
    AuditAction.WORKSPACE_CREATED,
    AuditAction.ORGANIZATION_MEMBERSHIP_ROLE_CHANGED,
    AuditAction.WORKSPACE_MEMBERSHIP_ROLE_CHANGED,
    AuditAction.WORKSPACE_MEMBERSHIP_SUSPENDED,
    AuditAction.WORKSPACE_MEMBERSHIP_RESUMED,
    AuditAction.WORKSPACE_MEMBERSHIP_REVOKED,
    AuditAction.ORGANIZATION_MEMBERSHIP_SUSPENDED,
    AuditAction.ORGANIZATION_MEMBERSHIP_RESUMED,
    AuditAction.ORGANIZATION_MEMBERSHIP_REVOKED,
    AuditAction.ORGANIZATION_OWNERSHIP_TRANSFERRED,
    AuditAction.WORKSPACE_OWNERSHIP_TRANSFERRED,
    AuditAction.WORKSPACE_ARCHIVED,
    AuditAction.WORKSPACE_RESTORED,
    AuditAction.ORGANIZATION_ARCHIVED,
    AuditAction.ORGANIZATION_RESTORED,
  ];

  for (const action of expectedActions) {
    assert.ok(actions.has(action), `Expected audit action ${action}`);
  }
});

test('a failed audit insert rolls back the protected workspace mutation', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
    'Rollback',
  );

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_audit_event_insert_for_test() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit insert failure';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_audit_event_insert_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_audit_event_insert_for_test();
  `);

  try {
    await assert.rejects(archiveWorkspace(prisma, ownerId, workspace.id));
    const persistedWorkspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
    });
    assert.equal(persistedWorkspace.status, WorkspaceStatus.ACTIVE);
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_audit_event_insert_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_audit_event_insert_for_test();');
  }
});

test('audit events reject update and delete attempts', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
    'Immutable',
  );
  const event = await prisma.auditEvent.findFirstOrThrow({
    where: { action: AuditAction.WORKSPACE_CREATED, targetId: workspace.id },
  });

  await assert.rejects(
    prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'workspace.changed' } }),
  );
  await assert.rejects(prisma.auditEvent.delete({ where: { id: event.id } }));
  assert.equal(await prisma.auditEvent.count({ where: { id: event.id } }), 1);
});
