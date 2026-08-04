import { randomUUID } from 'node:crypto';

import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';

export class WorkspaceCreationError extends Error {}

export class WorkspaceAuthorizationError extends WorkspaceCreationError {}

export class WorkspaceValidationError extends WorkspaceCreationError {}

function createWorkspaceSlug(name: string): string {
  const baseSlug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return `${baseSlug || 'workspace'}-${randomUUID().slice(0, 8)}`;
}

function getWorkspaceName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');

  if (name.length < 1 || name.length > 120) {
    throw new WorkspaceValidationError(
      'Workspace names must contain between 1 and 120 characters.',
    );
  }

  return name;
}

/** Creates an active workspace and its creator's owner membership atomically. */
export async function createWorkspaceForOrganization(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  requestedName: string,
): Promise<{ id: string; name: string; slug: string }> {
  const name = getWorkspaceName(requestedName);

  return prisma.$transaction(async (transaction) => {
    const authorizedMembership = await transaction.organizationMembership.findFirst({
      where: {
        organization: {
          deletedAt: null,
          status: OrganizationStatus.ACTIVE,
        },
        organizationId,
        role: {
          in: [OrganizationRole.OWNER, OrganizationRole.ADMIN],
        },
        status: MembershipStatus.ACTIVE,
        user: {
          deletedAt: null,
          status: UserStatus.ACTIVE,
        },
        userId,
      },
      select: { id: true },
    });

    if (!authorizedMembership) {
      throw new WorkspaceAuthorizationError('An active organization owner or admin is required.');
    }

    const workspace = await transaction.workspace.create({
      data: {
        createdByUserId: userId,
        name,
        organizationId,
        slug: createWorkspaceSlug(name),
        status: WorkspaceStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });

    await transaction.workspaceMembership.create({
      data: {
        activatedAt: new Date(),
        role: WorkspaceRole.OWNER,
        status: MembershipStatus.ACTIVE,
        userId,
        workspaceId: workspace.id,
      },
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.WORKSPACE_CREATED,
      actorUserId: userId,
      metadata: {
        name: workspace.name,
        slug: workspace.slug,
      },
      organizationId,
      targetId: workspace.id,
      targetType: AuditTargetType.WORKSPACE,
      workspaceId: workspace.id,
    });

    return workspace;
  });
}
