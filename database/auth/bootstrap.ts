import { randomUUID } from 'node:crypto';

import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';

/**
 * Creates the initial tenancy boundary for a credentialed user exactly once.
 * The membership is the source of authority; createdByUserId remains attribution only.
 */
export async function bootstrapOrganizationForFirstSignIn(
  prisma: PrismaClient,
  userId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`skyos:bootstrap:${userId}`}))
    `;

    const existingMembership = await transaction.organizationMembership.findFirst({
      where: { userId },
      select: { id: true },
    });

    if (existingMembership) {
      return;
    }

    const user = await transaction.user.findUniqueOrThrow({
      where: { id: userId },
      select: { displayName: true, name: true },
    });
    const organizationName = user.displayName ?? user.name ?? 'SkyOS';
    const organization = await transaction.organization.create({
      data: {
        createdByUserId: userId,
        name: `${organizationName} organization`,
        slug: `organization-${randomUUID()}`,
        status: OrganizationStatus.ACTIVE,
      },
    });

    await transaction.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId: organization.id,
        role: OrganizationRole.OWNER,
        status: MembershipStatus.ACTIVE,
        userId,
      },
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.ORGANIZATION_CREATED,
      actorUserId: userId,
      metadata: {
        name: organization.name,
        slug: organization.slug,
        source: 'first_sign_in',
      },
      organizationId: organization.id,
      targetId: organization.id,
      targetType: AuditTargetType.ORGANIZATION,
    });
  });
}
