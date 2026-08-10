import {
  MembershipStatus,
  OrganizationStatus,
  Prisma,
  type PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import { organizationRoleGrantsPermission } from '../policy/authorization-policy';
import {
  normalizeTenantName,
  normalizeTenantSlug,
  TenantInputValidationError,
} from './tenant-input';

export class WorkspaceCreationError extends Error {}

export class WorkspaceAuthorizationError extends WorkspaceCreationError {}

export class WorkspaceConflictError extends WorkspaceCreationError {}

export class WorkspaceValidationError extends WorkspaceCreationError {}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Creates an active workspace and its creator's owner membership atomically. */
export async function createWorkspaceForOrganization(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  requestedName: string,
  requestedSlug = requestedName,
): Promise<{ id: string; name: string; slug: string }> {
  let name: string;
  let slug: string;

  try {
    name = normalizeTenantName(requestedName, 'Workspace');
    slug = normalizeTenantSlug(requestedSlug);
  } catch (error) {
    if (error instanceof TenantInputValidationError) {
      throw new WorkspaceValidationError(error.message);
    }

    throw error;
  }

  try {
    return await prisma.$transaction(async (transaction) => {
      const authorizedMembership = await transaction.organizationMembership.findFirst({
        where: {
          organization: {
            deletedAt: null,
            status: OrganizationStatus.ACTIVE,
          },
          organizationId,
          status: MembershipStatus.ACTIVE,
          user: {
            deletedAt: null,
            status: UserStatus.ACTIVE,
          },
          userId,
        },
        select: { role: true },
      });

      if (
        !authorizedMembership ||
        !organizationRoleGrantsPermission(
          authorizedMembership.role,
          'organization.workspaces.create',
        )
      ) {
        throw new WorkspaceAuthorizationError(
          'An active organization membership with workspace creation permission is required.',
        );
      }

      const workspace = await transaction.workspace.create({
        data: {
          createdByUserId: userId,
          name,
          organizationId,
          slug,
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
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new WorkspaceConflictError('That workspace slug is already in use here.');
    }

    throw error;
  }
}
