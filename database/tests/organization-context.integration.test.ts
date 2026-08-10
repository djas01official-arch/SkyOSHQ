import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { getOrganizationContext } from '../context/organization-context';
import {
  createOrganizationForUser,
  OrganizationAuthorizationError,
  OrganizationConflictError,
} from '../context/organization-creation';
import {
  createWorkspaceForOrganization,
  WorkspaceAuthorizationError,
  WorkspaceConflictError,
} from '../context/workspace-creation';
import { AuditAction } from '../audit/audit-event';
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

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      identitySubject: `test:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });

  return user.id;
}

async function createOrganization(userId: string, role: OrganizationRole): Promise<string> {
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: userId,
      name: `Organization ${randomUUID()}`,
      slug: `organization-${randomUUID()}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role,
      status: MembershipStatus.ACTIVE,
      userId,
    },
  });

  return organization.id;
}

async function createWorkspace(organizationId: string, userId: string): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      createdByUserId: userId,
      name: `Workspace ${randomUUID()}`,
      organizationId,
      slug: `workspace-${randomUUID()}`,
      status: WorkspaceStatus.ACTIVE,
    },
  });

  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId,
      workspaceId: workspace.id,
    },
  });

  return workspace.id;
}

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

test('organization owners enumerate their directory but select only effective workspaces', async () => {
  const userId = await createUser();
  const organizationId = await createOrganization(userId, OrganizationRole.OWNER);
  const accessibleWorkspaceId = await createWorkspace(organizationId, userId);
  const otherUserId = await createUser();
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: otherUserId,
    },
  });
  const inaccessibleWorkspaceId = await createWorkspace(organizationId, otherUserId);

  const context = await getOrganizationContext(prisma, userId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: inaccessibleWorkspaceId,
  });

  assert.equal(context.activeOrganization?.id, organizationId);
  assert.equal(context.workspaces.length, 2);
  assert.equal(
    context.workspaces.find((workspace) => workspace.id === inaccessibleWorkspaceId)
      ?.hasActiveMembership,
    false,
  );
  assert.equal(context.activeWorkspace?.id, accessibleWorkspaceId);
});

test('organization context lists only active accessible organizations and rejects stale selection', async () => {
  const userId = await createUser();
  const firstOrganizationId = await createOrganization(userId, OrganizationRole.OWNER);
  const secondOwnerId = await createUser();
  const secondOrganizationId = await createOrganization(secondOwnerId, OrganizationRole.OWNER);
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: secondOrganizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId,
    },
  });
  const otherUserId = await createUser();
  const inaccessibleOrganizationId = await createOrganization(otherUserId, OrganizationRole.OWNER);

  const context = await getOrganizationContext(prisma, userId, {
    activeOrganizationId: inaccessibleOrganizationId,
  });

  assert.deepEqual(
    new Set(context.organizations.map((organization) => organization.id)),
    new Set([firstOrganizationId, secondOrganizationId]),
  );
  assert.notEqual(context.activeOrganization?.id, inaccessibleOrganizationId);

  await prisma.organizationMembership.update({
    where: {
      organizationId_userId: { organizationId: secondOrganizationId, userId },
    },
    data: { status: MembershipStatus.SUSPENDED },
  });
  const afterSuspension = await getOrganizationContext(prisma, userId, {
    activeOrganizationId: secondOrganizationId,
  });
  assert.deepEqual(
    afterSuspension.organizations.map((organization) => organization.id),
    [firstOrganizationId],
  );

  await prisma.organization.update({
    where: { id: firstOrganizationId },
    data: { archivedAt: new Date(), status: OrganizationStatus.ARCHIVED },
  });
  const afterArchive = await getOrganizationContext(prisma, userId);
  assert.equal(afterArchive.activeOrganization, null);
  assert.equal(afterArchive.organizations.length, 0);
});

test('organization creation normalizes its slug and atomically creates ownership and audit', async () => {
  const userId = await createUser();
  const organization = await createOrganizationForUser(
    prisma,
    userId,
    '  North   Star Operations  ',
    ' North Star / Operations ',
  );

  assert.equal(organization.name, 'North Star Operations');
  assert.equal(organization.slug, 'north-star-operations');
  const membership = await prisma.organizationMembership.findUniqueOrThrow({
    where: {
      organizationId_userId: { organizationId: organization.id, userId },
    },
  });
  assert.equal(membership.role, OrganizationRole.OWNER);
  assert.equal(membership.status, MembershipStatus.ACTIVE);

  const event = await prisma.auditEvent.findFirstOrThrow({
    where: { action: AuditAction.ORGANIZATION_CREATED, targetId: organization.id },
  });
  assert.equal(event.actorUserId, userId);
  assert.equal(event.organizationId, organization.id);
  assert.deepEqual(event.metadata, {
    name: 'North Star Operations',
    slug: 'north-star-operations',
  });
});

test('organization creation rejects inactive users and duplicate normalized slugs', async () => {
  const firstUserId = await createUser();
  await createOrganizationForUser(prisma, firstUserId, 'First', 'Shared Tenant');

  const secondUserId = await createUser();
  await assert.rejects(
    createOrganizationForUser(prisma, secondUserId, 'Second', 'shared---tenant'),
    OrganizationConflictError,
  );
  assert.equal(await prisma.organization.count({ where: { slug: 'shared-tenant' } }), 1);

  await prisma.user.update({
    where: { id: secondUserId },
    data: { status: UserStatus.SUSPENDED },
  });
  await assert.rejects(
    createOrganizationForUser(prisma, secondUserId, 'Suspended', 'suspended-tenant'),
    OrganizationAuthorizationError,
  );
});

test('organization creation rolls back when its audit event cannot be written', async () => {
  const userId = await createUser();
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS reject_organization_audit_for_test ON "audit_events";',
  );
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_organization_audit_for_test();');
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION reject_organization_audit_for_test() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'organization.created' THEN
        RAISE EXCEPTION 'forced organization audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER reject_organization_audit_for_test
    BEFORE INSERT ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION reject_organization_audit_for_test();
  `);

  try {
    await assert.rejects(
      createOrganizationForUser(prisma, userId, 'Rollback Tenant', 'rollback-tenant'),
    );
    assert.equal(await prisma.organization.count({ where: { slug: 'rollback-tenant' } }), 0);
    assert.equal(await prisma.organizationMembership.count({ where: { userId } }), 0);
  } finally {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS reject_organization_audit_for_test ON "audit_events";',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS reject_organization_audit_for_test();');
  }
});

test('members discover only workspaces where they have an active workspace membership', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId, OrganizationRole.OWNER);
  const grantedWorkspaceId = await createWorkspace(organizationId, ownerId);
  await createWorkspace(organizationId, ownerId);

  const memberId = await createUser();
  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      userId: memberId,
    },
  });
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.VIEWER,
      status: MembershipStatus.ACTIVE,
      userId: memberId,
      workspaceId: grantedWorkspaceId,
    },
  });

  const context = await getOrganizationContext(prisma, memberId);

  assert.equal(context.workspaces.length, 1);
  assert.equal(context.activeWorkspace?.id, grantedWorkspaceId);
  assert.equal(context.activeWorkspace?.role, WorkspaceRole.VIEWER);
  assert.equal(context.canCreateWorkspace, false);

  await prisma.workspaceMembership.update({
    where: { workspaceId_userId: { userId: memberId, workspaceId: grantedWorkspaceId } },
    data: { status: MembershipStatus.SUSPENDED },
  });
  const afterWorkspaceSuspension = await getOrganizationContext(prisma, memberId);
  assert.equal(afterWorkspaceSuspension.workspaces.length, 0);
  assert.equal(afterWorkspaceSuspension.activeWorkspace, null);
});

test('workspace discovery follows every organization role without implying content access', async (context) => {
  for (const role of [
    OrganizationRole.OWNER,
    OrganizationRole.ADMIN,
    OrganizationRole.MEMBER,
    OrganizationRole.VIEWER,
  ]) {
    await context.test(role.toLowerCase(), async () => {
      const userId = await createUser();
      const ownerId = role === OrganizationRole.OWNER ? userId : await createUser();
      const organizationId = await createOrganization(ownerId, OrganizationRole.OWNER);
      if (role !== OrganizationRole.OWNER) {
        await prisma.organizationMembership.create({
          data: {
            activatedAt: new Date(),
            organizationId,
            role,
            status: MembershipStatus.ACTIVE,
            userId,
          },
        });
      }
      const grantedWorkspaceId = await createWorkspace(organizationId, userId);
      const otherUserId = await createUser();
      await prisma.organizationMembership.create({
        data: {
          activatedAt: new Date(),
          organizationId,
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
          userId: otherUserId,
        },
      });
      const directoryOnlyWorkspaceId = await createWorkspace(organizationId, otherUserId);

      const resolved = await getOrganizationContext(prisma, userId);
      const canEnumerateDirectory =
        role === OrganizationRole.OWNER || role === OrganizationRole.ADMIN;

      assert.equal(resolved.workspaces.length, canEnumerateDirectory ? 2 : 1);
      assert.equal(resolved.activeWorkspace?.id, grantedWorkspaceId);
      assert.equal(
        resolved.workspaces.find((workspace) => workspace.id === directoryOnlyWorkspaceId)
          ?.hasActiveMembership,
        canEnumerateDirectory ? false : undefined,
      );
      assert.equal(
        resolved.canCreateWorkspace,
        role === OrganizationRole.OWNER || role === OrganizationRole.ADMIN,
      );
    });
  }
});

test('workspace context rejects cross-tenant selections and archived or ineffective scopes', async () => {
  const userId = await createUser();
  const firstOrganizationId = await createOrganization(userId, OrganizationRole.OWNER);
  const firstWorkspaceId = await createWorkspace(firstOrganizationId, userId);
  const secondOrganizationId = await createOrganization(userId, OrganizationRole.OWNER);
  const secondWorkspaceId = await createWorkspace(secondOrganizationId, userId);

  const crossTenant = await getOrganizationContext(prisma, userId, {
    activeOrganizationId: firstOrganizationId,
    activeWorkspaceId: secondWorkspaceId,
  });
  assert.equal(crossTenant.activeOrganization?.id, firstOrganizationId);
  assert.equal(crossTenant.activeWorkspace?.id, firstWorkspaceId);

  await prisma.workspace.update({
    where: { id: firstWorkspaceId },
    data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
  });
  const archivedWorkspace = await getOrganizationContext(prisma, userId, {
    activeOrganizationId: firstOrganizationId,
    activeWorkspaceId: firstWorkspaceId,
  });
  assert.equal(archivedWorkspace.workspaces.length, 0);
  assert.equal(archivedWorkspace.activeWorkspace, null);

  await prisma.user.update({
    where: { id: userId },
    data: { status: UserStatus.SUSPENDED },
  });
  const inactiveUser = await getOrganizationContext(prisma, userId);
  assert.equal(inactiveUser.activeOrganization, null);
  assert.equal(inactiveUser.organizations.length, 0);
});

test('workspace creation requires an active organization owner or admin and assigns creator ownership', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId, OrganizationRole.OWNER);

  const createdWorkspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
    'Product Operations',
    'Product Operations',
  );
  const membership = await prisma.workspaceMembership.findUniqueOrThrow({
    where: {
      workspaceId_userId: {
        userId: ownerId,
        workspaceId: createdWorkspace.id,
      },
    },
  });

  assert.equal(membership.role, WorkspaceRole.OWNER);
  assert.equal(membership.status, MembershipStatus.ACTIVE);
  assert.equal(createdWorkspace.slug, 'product-operations');

  for (const role of [OrganizationRole.ADMIN, OrganizationRole.MEMBER, OrganizationRole.VIEWER]) {
    const actorId = await createUser();
    await prisma.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId,
        role,
        status: MembershipStatus.ACTIVE,
        userId: actorId,
      },
    });

    if (role === OrganizationRole.ADMIN) {
      const adminWorkspace = await createWorkspaceForOrganization(
        prisma,
        actorId,
        organizationId,
        'Admin Workspace',
        `admin-${randomUUID()}`,
      );
      const adminMembership = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { workspaceId_userId: { userId: actorId, workspaceId: adminWorkspace.id } },
      });
      assert.equal(adminMembership.role, WorkspaceRole.OWNER);
    } else {
      await assert.rejects(
        createWorkspaceForOrganization(
          prisma,
          actorId,
          organizationId,
          'Forbidden Workspace',
          `forbidden-${randomUUID()}`,
        ),
        WorkspaceAuthorizationError,
      );
    }
  }
});

test('workspace slugs are unique within an organization but reusable in another organization', async () => {
  const firstOwnerId = await createUser();
  const firstOrganizationId = await createOrganization(firstOwnerId, OrganizationRole.OWNER);
  await createWorkspaceForOrganization(
    prisma,
    firstOwnerId,
    firstOrganizationId,
    'Operations',
    'Shared Workspace',
  );
  await assert.rejects(
    createWorkspaceForOrganization(
      prisma,
      firstOwnerId,
      firstOrganizationId,
      'Duplicate',
      'shared---workspace',
    ),
    WorkspaceConflictError,
  );

  const secondOwnerId = await createUser();
  const secondOrganizationId = await createOrganization(secondOwnerId, OrganizationRole.OWNER);
  const secondWorkspace = await createWorkspaceForOrganization(
    prisma,
    secondOwnerId,
    secondOrganizationId,
    'Operations',
    'shared-workspace',
  );
  assert.equal(secondWorkspace.slug, 'shared-workspace');
});
