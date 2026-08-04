import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

import { PrismaPg } from '@prisma/adapter-pg';

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

type OrganizationWithOwner = {
  organizationId: string;
  ownerId: string;
  ownerMembershipId: string;
};

type WorkspaceWithOwner = OrganizationWithOwner & {
  workspaceId: string;
  workspaceOwnerMembershipId: string;
};

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      displayName: 'Integration Test User',
      identitySubject: `test:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });

  return user.id;
}

async function createOrganizationWithOwner(): Promise<OrganizationWithOwner> {
  const ownerId = await createUser();
  const organization = await prisma.organization.create({
    data: {
      name: 'Integration Test Organization',
      slug: `organization-${randomUUID()}`,
      createdByUserId: ownerId,
      status: OrganizationStatus.ACTIVE,
    },
  });
  const ownerMembership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: ownerId,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });

  return {
    organizationId: organization.id,
    ownerId,
    ownerMembershipId: ownerMembership.id,
  };
}

async function createWorkspaceWithOwner(): Promise<WorkspaceWithOwner> {
  const organization = await createOrganizationWithOwner();
  const workspace = await prisma.workspace.create({
    data: {
      organizationId: organization.organizationId,
      name: 'Integration Test Workspace',
      slug: `workspace-${randomUUID()}`,
      createdByUserId: organization.ownerId,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  const workspaceOwnerMembership = await prisma.workspaceMembership.create({
    data: {
      workspaceId: workspace.id,
      userId: organization.ownerId,
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });

  return {
    ...organization,
    workspaceId: workspace.id,
    workspaceOwnerMembershipId: workspaceOwnerMembership.id,
  };
}

async function createActiveOrganizationMember(
  organizationId: string,
): Promise<{ membershipId: string; userId: string }> {
  const userId = await createUser();
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId,
      userId,
      role: OrganizationRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });

  return { membershipId: membership.id, userId };
}

async function createActiveWorkspaceMember(workspaceId: string, userId: string): Promise<string> {
  const membership = await prisma.workspaceMembership.create({
    data: {
      workspaceId,
      userId,
      role: WorkspaceRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });

  return membership.id;
}

async function hasEffectiveWorkspaceMembership(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const result = await prisma.$queryRaw<{ effective: boolean }[]>`
    SELECT "has_effective_workspace_membership"(${workspaceId}::uuid, ${userId}::uuid) AS "effective"
  `;

  return result[0]?.effective ?? false;
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

test('a workspace belongs to one immutable organization', async () => {
  const workspace = await createWorkspaceWithOwner();
  const otherOrganization = await createOrganizationWithOwner();
  const record = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.workspaceId } });

  assert.equal(record.organizationId, workspace.organizationId);
  await assert.rejects(
    prisma.workspace.update({
      where: { id: workspace.workspaceId },
      data: { organizationId: otherOrganization.organizationId },
    }),
  );
});

test('organization membership parent and user identifiers cannot be reassigned', async () => {
  const organization = await createOrganizationWithOwner();
  const member = await createActiveOrganizationMember(organization.organizationId);
  const otherOrganization = await createOrganizationWithOwner();
  const otherUserId = await createUser();

  await assert.rejects(
    prisma.organizationMembership.update({
      where: { id: member.membershipId },
      data: { organizationId: otherOrganization.organizationId },
    }),
  );
  await assert.rejects(
    prisma.organizationMembership.update({
      where: { id: member.membershipId },
      data: { userId: otherUserId },
    }),
  );
});

test('workspace membership parent and user identifiers cannot be reassigned', async () => {
  const workspace = await createWorkspaceWithOwner();
  const member = await createActiveOrganizationMember(workspace.organizationId);
  const membershipId = await createActiveWorkspaceMember(workspace.workspaceId, member.userId);
  const otherWorkspace = await prisma.workspace.create({
    data: {
      organizationId: workspace.organizationId,
      name: 'Second Workspace',
      slug: `workspace-${randomUUID()}`,
      createdByUserId: workspace.ownerId,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  const otherUserId = await createUser();

  await assert.rejects(
    prisma.workspaceMembership.update({
      where: { id: membershipId },
      data: { workspaceId: otherWorkspace.id },
    }),
  );
  await assert.rejects(
    prisma.workspaceMembership.update({
      where: { id: membershipId },
      data: { userId: otherUserId },
    }),
  );
});

test('an active workspace membership requires an active parent organization membership', async () => {
  const workspace = await createWorkspaceWithOwner();
  const userId = await createUser();

  await assert.rejects(createActiveWorkspaceMember(workspace.workspaceId, userId));
});

test('suspended or revoked organization membership removes effective workspace access', async () => {
  const workspace = await createWorkspaceWithOwner();
  const member = await createActiveOrganizationMember(workspace.organizationId);

  await createActiveWorkspaceMember(workspace.workspaceId, member.userId);
  assert.equal(await hasEffectiveWorkspaceMembership(workspace.workspaceId, member.userId), true);

  await prisma.organizationMembership.update({
    where: { id: member.membershipId },
    data: { status: MembershipStatus.SUSPENDED },
  });
  assert.equal(await hasEffectiveWorkspaceMembership(workspace.workspaceId, member.userId), false);

  await prisma.organizationMembership.update({
    where: { id: member.membershipId },
    data: { activatedAt: new Date(), status: MembershipStatus.ACTIVE },
  });
  await prisma.organizationMembership.update({
    where: { id: member.membershipId },
    data: { revokedAt: new Date(), status: MembershipStatus.REVOKED },
  });
  assert.equal(await hasEffectiveWorkspaceMembership(workspace.workspaceId, member.userId), false);
});

test('duplicate organization memberships are rejected', async () => {
  const organization = await createOrganizationWithOwner();
  const member = await createActiveOrganizationMember(organization.organizationId);

  await assert.rejects(
    prisma.organizationMembership.create({
      data: {
        organizationId: organization.organizationId,
        userId: member.userId,
        role: OrganizationRole.MEMBER,
        status: MembershipStatus.ACTIVE,
        activatedAt: new Date(),
      },
    }),
  );
});

test('duplicate workspace memberships are rejected', async () => {
  const workspace = await createWorkspaceWithOwner();
  const member = await createActiveOrganizationMember(workspace.organizationId);

  await createActiveWorkspaceMember(workspace.workspaceId, member.userId);
  await assert.rejects(createActiveWorkspaceMember(workspace.workspaceId, member.userId));
});

test('the final active organization owner cannot be demoted, suspended, revoked, or removed', async () => {
  const organization = await createOrganizationWithOwner();

  await assert.rejects(
    prisma.organizationMembership.update({
      where: { id: organization.ownerMembershipId },
      data: { role: OrganizationRole.ADMIN },
    }),
  );
  await assert.rejects(
    prisma.organizationMembership.update({
      where: { id: organization.ownerMembershipId },
      data: { status: MembershipStatus.SUSPENDED },
    }),
  );
  await assert.rejects(
    prisma.organizationMembership.update({
      where: { id: organization.ownerMembershipId },
      data: { revokedAt: new Date(), status: MembershipStatus.REVOKED },
    }),
  );
  await assert.rejects(
    prisma.organizationMembership.delete({ where: { id: organization.ownerMembershipId } }),
  );
});

test('the final active workspace owner cannot be demoted, suspended, revoked, or removed', async () => {
  const workspace = await createWorkspaceWithOwner();

  await assert.rejects(
    prisma.workspaceMembership.update({
      where: { id: workspace.workspaceOwnerMembershipId },
      data: { role: WorkspaceRole.ADMIN },
    }),
  );
  await assert.rejects(
    prisma.workspaceMembership.update({
      where: { id: workspace.workspaceOwnerMembershipId },
      data: { status: MembershipStatus.SUSPENDED },
    }),
  );
  await assert.rejects(
    prisma.workspaceMembership.update({
      where: { id: workspace.workspaceOwnerMembershipId },
      data: { revokedAt: new Date(), status: MembershipStatus.REVOKED },
    }),
  );
  await assert.rejects(
    prisma.workspaceMembership.delete({ where: { id: workspace.workspaceOwnerMembershipId } }),
  );
});

test('organization and workspace role scopes cannot be crossed', async () => {
  const workspace = await createWorkspaceWithOwner();

  await assert.rejects(
    prisma.$executeRawUnsafe(
      'UPDATE "organization_memberships" SET "role" = \'OWNER\'::"WorkspaceRole" WHERE "id" = $1',
      workspace.ownerMembershipId,
    ),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      'UPDATE "workspace_memberships" SET "role" = \'OWNER\'::"OrganizationRole" WHERE "id" = $1',
      workspace.workspaceOwnerMembershipId,
    ),
  );
});

test('archived organizations and workspaces reject normal mutations', async () => {
  const workspace = await createWorkspaceWithOwner();
  const member = await createActiveOrganizationMember(workspace.organizationId);
  const workspaceMembershipId = await createActiveWorkspaceMember(
    workspace.workspaceId,
    member.userId,
  );

  await prisma.organization.update({
    where: { id: workspace.organizationId },
    data: { archivedAt: new Date(), status: OrganizationStatus.ARCHIVED },
  });
  await assert.rejects(
    prisma.organization.update({
      where: { id: workspace.organizationId },
      data: { name: 'Forbidden organization update' },
    }),
  );
  await assert.rejects(
    prisma.workspace.update({
      where: { id: workspace.workspaceId },
      data: { name: 'Forbidden workspace update' },
    }),
  );
  await assert.rejects(
    prisma.organizationMembership.update({
      where: { id: member.membershipId },
      data: { status: MembershipStatus.SUSPENDED },
    }),
  );

  await prisma.organization.update({
    where: { id: workspace.organizationId },
    data: { archivedAt: null, status: OrganizationStatus.ACTIVE },
  });
  await prisma.workspace.update({
    where: { id: workspace.workspaceId },
    data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
  });
  await assert.rejects(
    prisma.workspace.update({
      where: { id: workspace.workspaceId },
      data: { name: 'Forbidden archived workspace update' },
    }),
  );
  await assert.rejects(
    prisma.workspaceMembership.update({
      where: { id: workspaceMembershipId },
      data: { status: MembershipStatus.SUSPENDED },
    }),
  );
});
