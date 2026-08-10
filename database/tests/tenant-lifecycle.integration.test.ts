import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { AuditAction } from '../audit/audit-event';
import { getOrganizationContext } from '../context/organization-context';
import { getTenantManagementContext } from '../context/tenant-management';
import {
  createWorkspaceForOrganization,
  WorkspaceAuthorizationError,
} from '../context/workspace-creation';
import {
  archiveOrganization,
  archiveWorkspace,
  PrivilegedAuthorizationError,
  restoreOrganization,
  restoreWorkspace,
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
  await addOrganizationMembership(organization.id, ownerId, OrganizationRole.OWNER);

  return organization.id;
}

async function addOrganizationMembership(
  organizationId: string,
  userId: string,
  role: OrganizationRole,
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

async function addWorkspaceMembership(workspaceId: string, userId: string, role: WorkspaceRole) {
  return prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId,
    },
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

test('only an active organization owner can archive and restore an organization', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
    'Owned workspace',
  );
  const unauthorizedActorIds: string[] = [];

  for (const role of [OrganizationRole.ADMIN, OrganizationRole.MEMBER, OrganizationRole.VIEWER]) {
    const actorId = await createUser();
    unauthorizedActorIds.push(actorId);
    await addOrganizationMembership(organizationId, actorId, role);
    await assert.rejects(
      archiveOrganization(prisma, actorId, organizationId),
      PrivilegedAuthorizationError,
    );
  }

  await archiveOrganization(prisma, ownerId, organizationId);

  const archived = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
  });
  assert.equal(archived.status, OrganizationStatus.ARCHIVED);
  assert.ok(archived.archivedAt);
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.ORGANIZATION_ARCHIVED, targetId: organizationId },
    }),
    1,
  );

  for (const actorId of unauthorizedActorIds) {
    await assert.rejects(
      restoreOrganization(prisma, actorId, organizationId),
      PrivilegedAuthorizationError,
    );
  }

  const staleContext = await getOrganizationContext(prisma, ownerId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: workspace.id,
  });
  assert.equal(staleContext.activeOrganization, null);
  assert.equal(staleContext.activeWorkspace, null);
  await assert.rejects(
    createWorkspaceForOrganization(prisma, ownerId, organizationId, 'Blocked workspace'),
    WorkspaceAuthorizationError,
  );

  const management = await getTenantManagementContext(prisma, ownerId);
  assert.deepEqual(
    management.archivedOrganizations.map((organization) => organization.id),
    [organizationId],
  );

  await restoreOrganization(prisma, ownerId, organizationId);

  const restored = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
  });
  assert.equal(restored.status, OrganizationStatus.ACTIVE);
  assert.equal(restored.archivedAt, null);
  assert.equal(
    await prisma.organizationMembership.count({
      where: {
        organizationId,
        role: OrganizationRole.OWNER,
        status: MembershipStatus.ACTIVE,
        userId: ownerId,
      },
    }),
    1,
  );
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.ORGANIZATION_RESTORED, targetId: organizationId },
    }),
    1,
  );
});

test('an archived organization preference falls back to another effective tenant', async () => {
  const ownerId = await createUser();
  const archivedOrganizationId = await createOrganization(ownerId);
  const archivedWorkspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    archivedOrganizationId,
    'Archived tenant workspace',
  );
  const fallbackOrganizationId = await createOrganization(ownerId);
  const fallbackWorkspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    fallbackOrganizationId,
    'Fallback workspace',
  );

  await archiveOrganization(prisma, ownerId, archivedOrganizationId);
  const context = await getOrganizationContext(prisma, ownerId, {
    activeOrganizationId: archivedOrganizationId,
    activeWorkspaceId: archivedWorkspace.id,
  });

  assert.equal(context.activeOrganization?.id, fallbackOrganizationId);
  assert.equal(context.activeWorkspace?.id, fallbackWorkspace.id);
  assert.ok(!context.organizations.some(({ id }) => id === archivedOrganizationId));
});

test('workspace lifecycle preserves scoped authorization, context, membership, and audit', async () => {
  const organizationOwnerId = await createUser();
  const organizationId = await createOrganization(organizationOwnerId);
  const workspace = await createWorkspaceForOrganization(
    prisma,
    organizationOwnerId,
    organizationId,
    'Lifecycle workspace',
  );
  const fallbackWorkspace = await createWorkspaceForOrganization(
    prisma,
    organizationOwnerId,
    organizationId,
    'Fallback workspace',
  );
  const unauthorizedActorIds: string[] = [];

  for (const role of [WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER]) {
    const actorId = await createUser();
    unauthorizedActorIds.push(actorId);
    await addOrganizationMembership(organizationId, actorId, OrganizationRole.MEMBER);
    await addWorkspaceMembership(workspace.id, actorId, role);
    await assert.rejects(
      archiveWorkspace(prisma, actorId, workspace.id),
      PrivilegedAuthorizationError,
    );
  }

  const workspaceOwnerId = await createUser();
  await addOrganizationMembership(organizationId, workspaceOwnerId, OrganizationRole.MEMBER);
  const workspaceOwnerMembership = await addWorkspaceMembership(
    workspace.id,
    workspaceOwnerId,
    WorkspaceRole.OWNER,
  );
  await addWorkspaceMembership(fallbackWorkspace.id, workspaceOwnerId, WorkspaceRole.OWNER);

  await archiveWorkspace(prisma, workspaceOwnerId, workspace.id);
  const staleContext = await getOrganizationContext(prisma, workspaceOwnerId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: workspace.id,
  });
  assert.equal(staleContext.activeWorkspace?.id, fallbackWorkspace.id);
  assert.ok(!staleContext.workspaces.some(({ id }) => id === workspace.id));

  const management = await getTenantManagementContext(prisma, workspaceOwnerId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: workspace.id,
  });
  assert.equal(management.canArchiveOrganization, false);
  assert.equal(management.canArchiveWorkspace, false);
  assert.deepEqual(
    management.archivedWorkspaces.map(({ id }) => id),
    [workspace.id],
  );

  for (const actorId of unauthorizedActorIds) {
    await assert.rejects(
      restoreWorkspace(prisma, actorId, workspace.id),
      PrivilegedAuthorizationError,
    );
  }

  await restoreWorkspace(prisma, workspaceOwnerId, workspace.id);
  const restored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  const persistedMembership = await prisma.workspaceMembership.findUniqueOrThrow({
    where: { id: workspaceOwnerMembership.id },
  });
  assert.equal(restored.organizationId, organizationId);
  assert.equal(restored.status, WorkspaceStatus.ACTIVE);
  assert.equal(restored.archivedAt, null);
  assert.equal(persistedMembership.role, WorkspaceRole.OWNER);
  assert.equal(persistedMembership.status, MembershipStatus.ACTIVE);
  assert.equal(
    await prisma.auditEvent.count({
      where: {
        action: { in: [AuditAction.WORKSPACE_ARCHIVED, AuditAction.WORKSPACE_RESTORED] },
        targetId: workspace.id,
      },
    }),
    2,
  );
});

test('organization workspace managers retain container lifecycle authority without content access', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId);
  const workspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
    'Admin managed workspace',
  );
  const adminId = await createUser();
  await addOrganizationMembership(organizationId, adminId, OrganizationRole.ADMIN);

  const beforeArchive = await getOrganizationContext(prisma, adminId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: workspace.id,
  });
  assert.equal(beforeArchive.activeWorkspace, null);

  await archiveWorkspace(prisma, adminId, workspace.id);
  const management = await getTenantManagementContext(prisma, adminId, {
    activeOrganizationId: organizationId,
  });
  assert.deepEqual(
    management.archivedWorkspaces.map(({ id }) => id),
    [workspace.id],
  );
  await restoreWorkspace(prisma, adminId, workspace.id);

  const afterRestore = await getOrganizationContext(prisma, adminId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: workspace.id,
  });
  assert.equal(afterRestore.activeWorkspace, null);
});

test('cross-tenant organization and workspace lifecycle attempts are rejected', async () => {
  const targetOwnerId = await createUser();
  const targetOrganizationId = await createOrganization(targetOwnerId);
  const targetWorkspace = await createWorkspaceForOrganization(
    prisma,
    targetOwnerId,
    targetOrganizationId,
    'Target workspace',
  );
  const foreignOwnerId = await createUser();
  await createOrganization(foreignOwnerId);

  await assert.rejects(
    archiveOrganization(prisma, foreignOwnerId, targetOrganizationId),
    PrivilegedAuthorizationError,
  );
  await assert.rejects(
    archiveWorkspace(prisma, foreignOwnerId, targetWorkspace.id),
    PrivilegedAuthorizationError,
  );
  const persisted = await prisma.workspace.findUniqueOrThrow({
    where: { id: targetWorkspace.id },
  });
  assert.equal(persisted.status, WorkspaceStatus.ACTIVE);
  assert.equal(
    await prisma.auditEvent.count({
      where: { action: AuditAction.WORKSPACE_ARCHIVED, targetId: targetWorkspace.id },
    }),
    0,
  );
});
