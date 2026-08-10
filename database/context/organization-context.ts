import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../generated/client/client';
import { organizationRoleGrantsPermission } from '../policy/authorization-policy';

export type OrganizationSummary = {
  id: string;
  name: string;
  role: OrganizationRole;
  slug: string;
};

export type WorkspaceSummary = {
  hasActiveMembership: boolean;
  id: string;
  name: string;
  role: WorkspaceRole | null;
  slug: string;
};

export type OrganizationContext = {
  activeOrganization: OrganizationSummary | null;
  activeWorkspace: WorkspaceSummary | null;
  canCreateWorkspace: boolean;
  organizations: OrganizationSummary[];
  workspaces: WorkspaceSummary[];
};

export type ContextSelection = Readonly<{
  activeOrganizationId?: string | null;
  activeWorkspaceId?: string | null;
}>;

function canEnumerateOrganizationWorkspaces(role: OrganizationRole): boolean {
  return organizationRoleGrantsPermission(role, 'organization.workspaces.read');
}

function canCreateOrganizationWorkspaces(role: OrganizationRole): boolean {
  return organizationRoleGrantsPermission(role, 'organization.workspaces.create');
}

/**
 * Resolves a session preference against current tenancy state. The returned
 * workspace is always effective for the user; stale or unauthorized IDs fall
 * back to a safe current selection instead of granting access.
 */
export async function getOrganizationContext(
  prisma: PrismaClient,
  userId: string,
  selection: ContextSelection = {},
): Promise<OrganizationContext> {
  const memberships = await prisma.organizationMembership.findMany({
    where: {
      organization: {
        deletedAt: null,
        status: OrganizationStatus.ACTIVE,
      },
      status: MembershipStatus.ACTIVE,
      user: {
        deletedAt: null,
        status: UserStatus.ACTIVE,
      },
      userId,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
    orderBy: {
      organization: {
        name: 'asc',
      },
    },
  });

  const organizations = memberships.map(({ organization, role }) => ({
    id: organization.id,
    name: organization.name,
    role,
    slug: organization.slug,
  }));
  const activeOrganization =
    organizations.find((organization) => organization.id === selection.activeOrganizationId) ??
    organizations[0] ??
    null;

  if (!activeOrganization) {
    return {
      activeOrganization: null,
      activeWorkspace: null,
      canCreateWorkspace: false,
      organizations,
      workspaces: [],
    };
  }

  const workspaceDirectory = canEnumerateOrganizationWorkspaces(activeOrganization.role)
    ? await prisma.workspace.findMany({
        where: {
          deletedAt: null,
          organizationId: activeOrganization.id,
          status: WorkspaceStatus.ACTIVE,
        },
        include: {
          memberships: {
            select: { id: true, role: true },
            where: {
              status: MembershipStatus.ACTIVE,
              userId,
            },
          },
        },
        orderBy: { name: 'asc' },
      })
    : await prisma.workspace.findMany({
        where: {
          deletedAt: null,
          memberships: {
            some: {
              status: MembershipStatus.ACTIVE,
              userId,
            },
          },
          organizationId: activeOrganization.id,
          status: WorkspaceStatus.ACTIVE,
        },
        include: {
          memberships: {
            select: { id: true, role: true },
            where: {
              status: MembershipStatus.ACTIVE,
              userId,
            },
          },
        },
        orderBy: { name: 'asc' },
      });
  const workspaces = workspaceDirectory.map((workspace) => ({
    hasActiveMembership: workspace.memberships.length > 0,
    id: workspace.id,
    name: workspace.name,
    role: workspace.memberships[0]?.role ?? null,
    slug: workspace.slug,
  }));
  const selectableWorkspaces = workspaces.filter((workspace) => workspace.hasActiveMembership);
  const activeWorkspace =
    selectableWorkspaces.find((workspace) => workspace.id === selection.activeWorkspaceId) ??
    selectableWorkspaces[0] ??
    null;

  return {
    activeOrganization,
    activeWorkspace,
    canCreateWorkspace: canCreateOrganizationWorkspaces(activeOrganization.role),
    organizations,
    workspaces,
  };
}
