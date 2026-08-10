import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  Prisma,
  type PrismaClient,
  UserStatus,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import {
  normalizeTenantName,
  normalizeTenantSlug,
  TenantInputValidationError,
} from './tenant-input';

export class OrganizationCreationError extends Error {}

export class OrganizationAuthorizationError extends OrganizationCreationError {}

export class OrganizationConflictError extends OrganizationCreationError {}

export class OrganizationValidationError extends OrganizationCreationError {}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Creates an active organization and its creator's owner membership atomically. */
export async function createOrganizationForUser(
  prisma: PrismaClient,
  userId: string,
  requestedName: string,
  requestedSlug: string,
): Promise<{ id: string; name: string; slug: string }> {
  let name: string;
  let slug: string;

  try {
    name = normalizeTenantName(requestedName, 'Organization');
    slug = normalizeTenantSlug(requestedSlug);
  } catch (error) {
    if (error instanceof TenantInputValidationError) {
      throw new OrganizationValidationError(error.message);
    }

    throw error;
  }

  try {
    return await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findFirst({
        where: {
          deletedAt: null,
          id: userId,
          status: UserStatus.ACTIVE,
        },
        select: { id: true },
      });

      if (!user) {
        throw new OrganizationAuthorizationError('An active user is required.');
      }

      const organization = await transaction.organization.create({
        data: {
          createdByUserId: user.id,
          name,
          slug,
          status: OrganizationStatus.ACTIVE,
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      });

      await transaction.organizationMembership.create({
        data: {
          activatedAt: new Date(),
          organizationId: organization.id,
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
          userId: user.id,
        },
      });

      await appendAuditEvent(transaction, {
        action: AuditAction.ORGANIZATION_CREATED,
        actorUserId: user.id,
        metadata: {
          name: organization.name,
          slug: organization.slug,
        },
        organizationId: organization.id,
        targetId: organization.id,
        targetType: AuditTargetType.ORGANIZATION,
      });

      return organization;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new OrganizationConflictError('That organization slug is already in use.');
    }

    throw error;
  }
}
