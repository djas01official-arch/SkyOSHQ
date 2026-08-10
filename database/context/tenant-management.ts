import {
  MembershipStatus,
  OrganizationStatus,
  type PrismaClient,
  UserStatus,
  WorkspaceStatus,
} from '../generated/client/client';
import {
  organizationRoleGrantsPermission,
  workspaceRoleGrantsPermission,
} from '../policy/authorization-policy';

export type ArchivedOrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
};

export type ArchivedWorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
};

export type TenantManagementContext = {
  archivedOrganizations: ArchivedOrganizationSummary[];
  archivedWorkspaces: ArchivedWorkspaceSummary[];
  canArchiveOrganization: boolean;
  canArchiveWorkspace: boolean;
};

export type TenantManagementSelection = Readonly<{
  activeOrganizationId?: string | null;
  activeWorkspaceId?: string | null;
}>;

const EMPTY_MANAGEMENT_CONTEXT: TenantManagementContext = {
  archivedOrganizations: [],
  archivedWorkspaces: [],
  canArchiveOrganization: false,
  canArchiveWorkspace: false,
};

/**
 * Resolves lifecycle controls from current persisted roles. Archived scopes are
 * management targets only and never become effective product context here.
 */
export async function getTenantManagementContext(
  prisma: PrismaClient,
  userId: string,
  selection: TenantManagementSelection = {},
): Promise<TenantManagementContext> {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, id: userId, status: UserStatus.ACTIVE },
    select: { id: true },
  });

  if (!user) {
    return EMPTY_MANAGEMENT_CONTEXT;
  }

  const [activeMembership, archivedMemberships] = await Promise.all([
    selection.activeOrganizationId
      ? prisma.organizationMembership.findFirst({
          where: {
            organization: {
              deletedAt: null,
              status: OrganizationStatus.ACTIVE,
            },
            organizationId: selection.activeOrganizationId,
            status: MembershipStatus.ACTIVE,
            userId,
          },
          select: { organizationId: true, role: true },
        })
      : null,
    prisma.organizationMembership.findMany({
      where: {
        organization: {
          deletedAt: null,
          status: OrganizationStatus.ARCHIVED,
        },
        status: MembershipStatus.ACTIVE,
        userId,
      },
      include: {
        organization: {
          select: { id: true, name: true, slug: true, status: true },
        },
      },
      orderBy: { organization: { name: 'asc' } },
    }),
  ]);

  const archivedOrganizations = archivedMemberships
    .filter(({ role }) => organizationRoleGrantsPermission(role, 'organization.archive'))
    .map(({ organization }) => organization);

  if (!activeMembership) {
    return {
      ...EMPTY_MANAGEMENT_CONTEXT,
      archivedOrganizations,
    };
  }

  const canManageOrganizationWorkspaces = organizationRoleGrantsPermission(
    activeMembership.role,
    'organization.workspaces.manage',
  );
  const workspaceDirectory = await prisma.workspace.findMany({
    where: {
      deletedAt: null,
      organizationId: activeMembership.organizationId,
      status: {
        in: [WorkspaceStatus.ACTIVE, WorkspaceStatus.ARCHIVED],
      },
      ...(canManageOrganizationWorkspaces
        ? {}
        : {
            memberships: {
              some: {
                status: MembershipStatus.ACTIVE,
                userId,
              },
            },
          }),
    },
    include: {
      memberships: {
        select: { role: true },
        where: {
          status: MembershipStatus.ACTIVE,
          userId,
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const manageableWorkspaces = workspaceDirectory.filter((workspace) => {
    const workspaceRole = workspace.memberships[0]?.role;

    return (
      canManageOrganizationWorkspaces ||
      (workspaceRole !== undefined &&
        workspaceRoleGrantsPermission(workspaceRole, 'workspace.archive'))
    );
  });
  const archivedWorkspaces = manageableWorkspaces
    .filter((workspace) => workspace.status === WorkspaceStatus.ARCHIVED)
    .map(({ id, name, slug, status }) => ({ id, name, slug, status }));
  const currentWorkspace = manageableWorkspaces.find(
    (workspace) =>
      workspace.id === selection.activeWorkspaceId && workspace.status === WorkspaceStatus.ACTIVE,
  );

  return {
    archivedOrganizations,
    archivedWorkspaces,
    canArchiveOrganization: organizationRoleGrantsPermission(
      activeMembership.role,
      'organization.archive',
    ),
    canArchiveWorkspace: currentWorkspace !== undefined,
  };
}
