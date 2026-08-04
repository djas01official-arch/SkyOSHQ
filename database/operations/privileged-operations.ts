import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type Prisma,
  type PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';

export class PrivilegedOperationError extends Error {}

export class PrivilegedAuthorizationError extends PrivilegedOperationError {}

export class PrivilegedStateError extends PrivilegedOperationError {}

type Transaction = Prisma.TransactionClient;

function isOrganizationRole(role: OrganizationRole, expected: OrganizationRole): boolean {
  return role === expected;
}

function isWorkspaceRole(role: WorkspaceRole, expected: WorkspaceRole): boolean {
  return role === expected;
}

async function getActiveOrganizationActor(
  transaction: Transaction,
  actorUserId: string,
  organizationId: string,
) {
  const membership = await transaction.organizationMembership.findFirst({
    where: {
      organizationId,
      status: MembershipStatus.ACTIVE,
      userId: actorUserId,
      user: {
        deletedAt: null,
        status: UserStatus.ACTIVE,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    throw new PrivilegedAuthorizationError('An active organization membership is required.');
  }

  return membership;
}

async function getOrganization(
  transaction: Transaction,
  organizationId: string,
  requireActive: boolean,
) {
  const organization = await transaction.organization.findFirst({
    where: {
      deletedAt: null,
      id: organizationId,
    },
    select: { id: true, status: true },
  });

  if (!organization) {
    throw new PrivilegedStateError('The organization does not exist.');
  }

  if (requireActive && organization.status !== OrganizationStatus.ACTIVE) {
    throw new PrivilegedStateError('Archived organizations reject normal mutations.');
  }

  return organization;
}

function assertOrganizationManager(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
  nextRole?: OrganizationRole,
): void {
  if (isOrganizationRole(actorRole, OrganizationRole.OWNER)) {
    return;
  }

  if (
    isOrganizationRole(actorRole, OrganizationRole.ADMIN) &&
    !isOrganizationRole(targetRole, OrganizationRole.OWNER) &&
    (!nextRole || !isOrganizationRole(nextRole, OrganizationRole.OWNER))
  ) {
    return;
  }

  throw new PrivilegedAuthorizationError(
    'Only organization owners can manage organization owner memberships.',
  );
}

async function getWorkspace(transaction: Transaction, workspaceId: string, requireActive: boolean) {
  const workspace = await transaction.workspace.findFirst({
    where: { deletedAt: null, id: workspaceId },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { deletedAt: true, status: true } },
      status: true,
    },
  });

  if (!workspace || workspace.organization.deletedAt) {
    throw new PrivilegedStateError('The workspace does not exist.');
  }

  if (
    requireActive &&
    (workspace.status !== WorkspaceStatus.ACTIVE ||
      workspace.organization.status !== OrganizationStatus.ACTIVE)
  ) {
    throw new PrivilegedStateError(
      'Archived organizations and workspaces reject normal mutations.',
    );
  }

  return workspace;
}

async function getWorkspaceActor(
  transaction: Transaction,
  actorUserId: string,
  workspaceId: string,
  requireActiveWorkspace: boolean,
) {
  const workspace = await getWorkspace(transaction, workspaceId, requireActiveWorkspace);
  const organizationMembership = await getActiveOrganizationActor(
    transaction,
    actorUserId,
    workspace.organizationId,
  );
  const workspaceMembership = await transaction.workspaceMembership.findFirst({
    where: {
      status: MembershipStatus.ACTIVE,
      userId: actorUserId,
      workspaceId,
    },
    select: { role: true },
  });

  return {
    ...workspace,
    organizationRole: organizationMembership.role,
    workspaceRole: workspaceMembership?.role,
  };
}

function assertWorkspaceManager(
  actorOrganizationRole: OrganizationRole,
  actorWorkspaceRole: WorkspaceRole | undefined,
  targetRole: WorkspaceRole,
  nextRole?: WorkspaceRole,
): void {
  if (isOrganizationRole(actorOrganizationRole, OrganizationRole.OWNER)) {
    return;
  }

  const changingOwner =
    isWorkspaceRole(targetRole, WorkspaceRole.OWNER) ||
    (nextRole ? isWorkspaceRole(nextRole, WorkspaceRole.OWNER) : false);

  if (isOrganizationRole(actorOrganizationRole, OrganizationRole.ADMIN)) {
    if (!changingOwner) {
      return;
    }
  } else if (isWorkspaceRole(actorWorkspaceRole ?? WorkspaceRole.VIEWER, WorkspaceRole.OWNER)) {
    return;
  } else if (
    isWorkspaceRole(actorWorkspaceRole ?? WorkspaceRole.VIEWER, WorkspaceRole.ADMIN) &&
    !changingOwner
  ) {
    return;
  }

  throw new PrivilegedAuthorizationError('The actor cannot manage this workspace membership role.');
}

async function setOrganizationMembershipStatus(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
  nextStatus: MembershipStatus,
  action:
    | typeof AuditAction.ORGANIZATION_MEMBERSHIP_SUSPENDED
    | typeof AuditAction.ORGANIZATION_MEMBERSHIP_RESUMED
    | typeof AuditAction.ORGANIZATION_MEMBERSHIP_REVOKED,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const membership = await transaction.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { id: true, organizationId: true, role: true, status: true, userId: true },
    });

    if (!membership) {
      throw new PrivilegedStateError('The organization membership does not exist.');
    }

    await getOrganization(transaction, membership.organizationId, true);
    const actor = await getActiveOrganizationActor(
      transaction,
      actorUserId,
      membership.organizationId,
    );
    assertOrganizationManager(actor.role, membership.role);

    const now = new Date();
    await transaction.organizationMembership.update({
      where: { id: membership.id },
      data: {
        activatedAt: nextStatus === MembershipStatus.ACTIVE ? now : undefined,
        revokedAt: nextStatus === MembershipStatus.REVOKED ? now : null,
        status: nextStatus,
      },
    });

    await appendAuditEvent(transaction, {
      action,
      actorUserId,
      metadata: {
        afterStatus: nextStatus,
        beforeStatus: membership.status,
        userId: membership.userId,
      },
      organizationId: membership.organizationId,
      targetId: membership.id,
      targetType: AuditTargetType.ORGANIZATION_MEMBERSHIP,
    });
  });
}

async function setWorkspaceMembershipStatus(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
  nextStatus: MembershipStatus,
  action:
    | typeof AuditAction.WORKSPACE_MEMBERSHIP_SUSPENDED
    | typeof AuditAction.WORKSPACE_MEMBERSHIP_RESUMED
    | typeof AuditAction.WORKSPACE_MEMBERSHIP_REVOKED,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const membership = await transaction.workspaceMembership.findUnique({
      where: { id: membershipId },
      select: { id: true, role: true, status: true, userId: true, workspaceId: true },
    });

    if (!membership) {
      throw new PrivilegedStateError('The workspace membership does not exist.');
    }

    const actor = await getWorkspaceActor(transaction, actorUserId, membership.workspaceId, true);
    assertWorkspaceManager(actor.organizationRole, actor.workspaceRole, membership.role);

    const now = new Date();
    await transaction.workspaceMembership.update({
      where: { id: membership.id },
      data: {
        activatedAt: nextStatus === MembershipStatus.ACTIVE ? now : undefined,
        revokedAt: nextStatus === MembershipStatus.REVOKED ? now : null,
        status: nextStatus,
      },
    });

    await appendAuditEvent(transaction, {
      action,
      actorUserId,
      metadata: {
        afterStatus: nextStatus,
        beforeStatus: membership.status,
        userId: membership.userId,
      },
      organizationId: actor.organizationId,
      targetId: membership.id,
      targetType: AuditTargetType.WORKSPACE_MEMBERSHIP,
      workspaceId: membership.workspaceId,
    });
  });
}

export async function archiveOrganization(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const organization = await getOrganization(transaction, organizationId, true);
    const actor = await getActiveOrganizationActor(transaction, actorUserId, organization.id);

    if (!isOrganizationRole(actor.role, OrganizationRole.OWNER)) {
      throw new PrivilegedAuthorizationError(
        'Only organization owners can archive an organization.',
      );
    }

    await transaction.organization.update({
      where: { id: organization.id },
      data: { archivedAt: new Date(), status: OrganizationStatus.ARCHIVED },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.ORGANIZATION_ARCHIVED,
      actorUserId,
      metadata: { afterStatus: OrganizationStatus.ARCHIVED, beforeStatus: organization.status },
      organizationId: organization.id,
      targetId: organization.id,
      targetType: AuditTargetType.ORGANIZATION,
    });
  });
}

export async function restoreOrganization(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const organization = await getOrganization(transaction, organizationId, false);
    const actor = await getActiveOrganizationActor(transaction, actorUserId, organization.id);

    if (!isOrganizationRole(actor.role, OrganizationRole.OWNER)) {
      throw new PrivilegedAuthorizationError(
        'Only organization owners can restore an organization.',
      );
    }
    if (organization.status !== OrganizationStatus.ARCHIVED) {
      throw new PrivilegedStateError('Only archived organizations can be restored.');
    }

    await transaction.organization.update({
      where: { id: organization.id },
      data: { archivedAt: null, status: OrganizationStatus.ACTIVE },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.ORGANIZATION_RESTORED,
      actorUserId,
      metadata: { afterStatus: OrganizationStatus.ACTIVE, beforeStatus: organization.status },
      organizationId: organization.id,
      targetId: organization.id,
      targetType: AuditTargetType.ORGANIZATION,
    });
  });
}

export async function archiveWorkspace(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const actor = await getWorkspaceActor(transaction, actorUserId, workspaceId, true);
    const canArchive =
      isOrganizationRole(actor.organizationRole, OrganizationRole.OWNER) ||
      isOrganizationRole(actor.organizationRole, OrganizationRole.ADMIN) ||
      isWorkspaceRole(actor.workspaceRole ?? WorkspaceRole.VIEWER, WorkspaceRole.OWNER);

    if (!canArchive) {
      throw new PrivilegedAuthorizationError(
        'An organization admin or workspace owner is required.',
      );
    }

    await transaction.workspace.update({
      where: { id: actor.id },
      data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.WORKSPACE_ARCHIVED,
      actorUserId,
      metadata: { afterStatus: WorkspaceStatus.ARCHIVED, beforeStatus: actor.status },
      organizationId: actor.organizationId,
      targetId: actor.id,
      targetType: AuditTargetType.WORKSPACE,
      workspaceId: actor.id,
    });
  });
}

export async function restoreWorkspace(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const actor = await getWorkspaceActor(transaction, actorUserId, workspaceId, false);
    if (actor.organization.status !== OrganizationStatus.ACTIVE) {
      throw new PrivilegedStateError('An archived organization cannot restore a workspace.');
    }
    const canRestore =
      isOrganizationRole(actor.organizationRole, OrganizationRole.OWNER) ||
      isOrganizationRole(actor.organizationRole, OrganizationRole.ADMIN) ||
      isWorkspaceRole(actor.workspaceRole ?? WorkspaceRole.VIEWER, WorkspaceRole.OWNER);

    if (!canRestore) {
      throw new PrivilegedAuthorizationError(
        'An organization admin or workspace owner is required.',
      );
    }
    if (actor.status !== WorkspaceStatus.ARCHIVED) {
      throw new PrivilegedStateError('Only archived workspaces can be restored.');
    }

    await transaction.workspace.update({
      where: { id: actor.id },
      data: { archivedAt: null, status: WorkspaceStatus.ACTIVE },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.WORKSPACE_RESTORED,
      actorUserId,
      metadata: { afterStatus: WorkspaceStatus.ACTIVE, beforeStatus: actor.status },
      organizationId: actor.organizationId,
      targetId: actor.id,
      targetType: AuditTargetType.WORKSPACE,
      workspaceId: actor.id,
    });
  });
}

export async function changeOrganizationMembershipRole(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
  role: OrganizationRole,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const membership = await transaction.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { id: true, organizationId: true, role: true, userId: true },
    });
    if (!membership) {
      throw new PrivilegedStateError('The organization membership does not exist.');
    }

    await getOrganization(transaction, membership.organizationId, true);
    const actor = await getActiveOrganizationActor(
      transaction,
      actorUserId,
      membership.organizationId,
    );
    assertOrganizationManager(actor.role, membership.role, role);

    await transaction.organizationMembership.update({
      where: { id: membership.id },
      data: { role },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.ORGANIZATION_MEMBERSHIP_ROLE_CHANGED,
      actorUserId,
      metadata: { afterRole: role, beforeRole: membership.role, userId: membership.userId },
      organizationId: membership.organizationId,
      targetId: membership.id,
      targetType: AuditTargetType.ORGANIZATION_MEMBERSHIP,
    });
  });
}

export async function changeWorkspaceMembershipRole(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
  role: WorkspaceRole,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const membership = await transaction.workspaceMembership.findUnique({
      where: { id: membershipId },
      select: { id: true, role: true, userId: true, workspaceId: true },
    });
    if (!membership) {
      throw new PrivilegedStateError('The workspace membership does not exist.');
    }

    const actor = await getWorkspaceActor(transaction, actorUserId, membership.workspaceId, true);
    assertWorkspaceManager(actor.organizationRole, actor.workspaceRole, membership.role, role);

    await transaction.workspaceMembership.update({ where: { id: membership.id }, data: { role } });
    await appendAuditEvent(transaction, {
      action: AuditAction.WORKSPACE_MEMBERSHIP_ROLE_CHANGED,
      actorUserId,
      metadata: { afterRole: role, beforeRole: membership.role, userId: membership.userId },
      organizationId: actor.organizationId,
      targetId: membership.id,
      targetType: AuditTargetType.WORKSPACE_MEMBERSHIP,
      workspaceId: membership.workspaceId,
    });
  });
}

export function suspendOrganizationMembership(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
): Promise<void> {
  return setOrganizationMembershipStatus(
    prisma,
    actorUserId,
    membershipId,
    MembershipStatus.SUSPENDED,
    AuditAction.ORGANIZATION_MEMBERSHIP_SUSPENDED,
  );
}

export function resumeOrganizationMembership(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
): Promise<void> {
  return setOrganizationMembershipStatus(
    prisma,
    actorUserId,
    membershipId,
    MembershipStatus.ACTIVE,
    AuditAction.ORGANIZATION_MEMBERSHIP_RESUMED,
  );
}

export function revokeOrganizationMembership(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
): Promise<void> {
  return setOrganizationMembershipStatus(
    prisma,
    actorUserId,
    membershipId,
    MembershipStatus.REVOKED,
    AuditAction.ORGANIZATION_MEMBERSHIP_REVOKED,
  );
}

export function suspendWorkspaceMembership(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
): Promise<void> {
  return setWorkspaceMembershipStatus(
    prisma,
    actorUserId,
    membershipId,
    MembershipStatus.SUSPENDED,
    AuditAction.WORKSPACE_MEMBERSHIP_SUSPENDED,
  );
}

export function resumeWorkspaceMembership(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
): Promise<void> {
  return setWorkspaceMembershipStatus(
    prisma,
    actorUserId,
    membershipId,
    MembershipStatus.ACTIVE,
    AuditAction.WORKSPACE_MEMBERSHIP_RESUMED,
  );
}

export function revokeWorkspaceMembership(
  prisma: PrismaClient,
  actorUserId: string,
  membershipId: string,
): Promise<void> {
  return setWorkspaceMembershipStatus(
    prisma,
    actorUserId,
    membershipId,
    MembershipStatus.REVOKED,
    AuditAction.WORKSPACE_MEMBERSHIP_REVOKED,
  );
}

export async function transferOrganizationOwnership(
  prisma: PrismaClient,
  actorUserId: string,
  currentOwnerMembershipId: string,
  successorMembershipId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    if (currentOwnerMembershipId === successorMembershipId) {
      throw new PrivilegedStateError('Ownership must be transferred to a different membership.');
    }
    const [currentOwner, successor] = await Promise.all([
      transaction.organizationMembership.findUnique({ where: { id: currentOwnerMembershipId } }),
      transaction.organizationMembership.findUnique({ where: { id: successorMembershipId } }),
    ]);
    if (!currentOwner || !successor || currentOwner.organizationId !== successor.organizationId) {
      throw new PrivilegedStateError('Both memberships must belong to the same organization.');
    }
    if (
      currentOwner.role !== OrganizationRole.OWNER ||
      currentOwner.status !== MembershipStatus.ACTIVE ||
      successor.status !== MembershipStatus.ACTIVE
    ) {
      throw new PrivilegedStateError('Both organization ownership participants must be active.');
    }

    await getOrganization(transaction, currentOwner.organizationId, true);
    const actor = await getActiveOrganizationActor(
      transaction,
      actorUserId,
      currentOwner.organizationId,
    );
    if (actor.role !== OrganizationRole.OWNER) {
      throw new PrivilegedAuthorizationError('Only organization owners can transfer ownership.');
    }

    await transaction.organizationMembership.update({
      where: { id: successor.id },
      data: { role: OrganizationRole.OWNER },
    });
    await transaction.organizationMembership.update({
      where: { id: currentOwner.id },
      data: { role: OrganizationRole.ADMIN },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.ORGANIZATION_OWNERSHIP_TRANSFERRED,
      actorUserId,
      metadata: {
        fromMembershipId: currentOwner.id,
        fromUserId: currentOwner.userId,
        toMembershipId: successor.id,
        toUserId: successor.userId,
      },
      organizationId: currentOwner.organizationId,
      targetId: currentOwner.organizationId,
      targetType: AuditTargetType.ORGANIZATION,
    });
  });
}

export async function transferWorkspaceOwnership(
  prisma: PrismaClient,
  actorUserId: string,
  currentOwnerMembershipId: string,
  successorMembershipId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    if (currentOwnerMembershipId === successorMembershipId) {
      throw new PrivilegedStateError('Ownership must be transferred to a different membership.');
    }
    const [currentOwner, successor] = await Promise.all([
      transaction.workspaceMembership.findUnique({ where: { id: currentOwnerMembershipId } }),
      transaction.workspaceMembership.findUnique({ where: { id: successorMembershipId } }),
    ]);
    if (!currentOwner || !successor || currentOwner.workspaceId !== successor.workspaceId) {
      throw new PrivilegedStateError('Both memberships must belong to the same workspace.');
    }
    if (
      currentOwner.role !== WorkspaceRole.OWNER ||
      currentOwner.status !== MembershipStatus.ACTIVE ||
      successor.status !== MembershipStatus.ACTIVE
    ) {
      throw new PrivilegedStateError('Both workspace ownership participants must be active.');
    }

    const actor = await getWorkspaceActor(transaction, actorUserId, currentOwner.workspaceId, true);
    const canTransfer =
      actor.organizationRole === OrganizationRole.OWNER ||
      actor.workspaceRole === WorkspaceRole.OWNER;
    if (!canTransfer) {
      throw new PrivilegedAuthorizationError('An organization or workspace owner is required.');
    }

    await transaction.workspaceMembership.update({
      where: { id: successor.id },
      data: { role: WorkspaceRole.OWNER },
    });
    await transaction.workspaceMembership.update({
      where: { id: currentOwner.id },
      data: { role: WorkspaceRole.ADMIN },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.WORKSPACE_OWNERSHIP_TRANSFERRED,
      actorUserId,
      metadata: {
        fromMembershipId: currentOwner.id,
        fromUserId: currentOwner.userId,
        toMembershipId: successor.id,
        toUserId: successor.userId,
      },
      organizationId: actor.organizationId,
      targetId: currentOwner.workspaceId,
      targetType: AuditTargetType.WORKSPACE,
      workspaceId: currentOwner.workspaceId,
    });
  });
}
