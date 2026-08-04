import process from 'node:process';

import argon2 from 'argon2';
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

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database.');
}

function requireEnvironmentVariable(name: 'AUTH_DEV_EMAIL' | 'AUTH_DEV_PASSWORD'): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required to seed development credentials.`);
  }

  return value;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main(): Promise<void> {
  const developmentEmail = requireEnvironmentVariable('AUTH_DEV_EMAIL');
  const developmentPassword = requireEnvironmentVariable('AUTH_DEV_PASSWORD');
  const passwordHash = await argon2.hash(developmentPassword, { type: argon2.argon2id });
  const user = await prisma.user.upsert({
    where: { email: developmentEmail },
    update: {
      deletedAt: null,
      displayName: 'SkyOS Owner',
      emailVerified: new Date(),
      name: 'SkyOS Owner',
      passwordHash,
      status: UserStatus.ACTIVE,
    },
    create: {
      email: developmentEmail,
      emailVerified: new Date(),
      identitySubject: `credentials:${developmentEmail}`,
      displayName: 'SkyOS Owner',
      name: 'SkyOS Owner',
      passwordHash,
      status: UserStatus.ACTIVE,
    },
  });

  const organization = await prisma.organization.findFirst({
    where: {
      slug: 'skyos-demo',
      status: OrganizationStatus.ACTIVE,
      deletedAt: null,
    },
  });

  const activeOrganization =
    organization ??
    (await prisma.organization.create({
      data: {
        name: 'SkyOS Demo',
        slug: 'skyos-demo',
        status: OrganizationStatus.ACTIVE,
        createdByUserId: user.id,
      },
    }));

  await prisma.organizationMembership.upsert({
    where: {
      organizationId_userId: {
        organizationId: activeOrganization.id,
        userId: user.id,
      },
    },
    update: {
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
      revokedAt: null,
    },
    create: {
      organizationId: activeOrganization.id,
      userId: user.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });

  const workspace = await prisma.workspace.findFirst({
    where: {
      organizationId: activeOrganization.id,
      slug: 'operations',
      status: WorkspaceStatus.ACTIVE,
      deletedAt: null,
    },
  });

  const activeWorkspace =
    workspace ??
    (await prisma.workspace.create({
      data: {
        organizationId: activeOrganization.id,
        name: 'Operations',
        slug: 'operations',
        status: WorkspaceStatus.ACTIVE,
        createdByUserId: user.id,
      },
    }));

  await prisma.workspaceMembership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: activeWorkspace.id,
        userId: user.id,
      },
    },
    update: {
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
      revokedAt: null,
    },
    create: {
      workspaceId: activeWorkspace.id,
      userId: user.id,
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });
}

main()
  .catch((error: unknown) => {
    console.error('Database seed failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
