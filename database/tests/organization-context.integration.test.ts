import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

import { getOrganizationContext } from '../context/organization-context';
import {
  createWorkspaceForOrganization,
  WorkspaceAuthorizationError,
} from '../context/workspace-creation';
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
});

test('workspace creation requires an active organization owner or admin and assigns creator ownership', async () => {
  const ownerId = await createUser();
  const organizationId = await createOrganization(ownerId, OrganizationRole.OWNER);

  const createdWorkspace = await createWorkspaceForOrganization(
    prisma,
    ownerId,
    organizationId,
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
  await assert.rejects(
    createWorkspaceForOrganization(prisma, memberId, organizationId, 'Forbidden Workspace'),
    WorkspaceAuthorizationError,
  );
});
