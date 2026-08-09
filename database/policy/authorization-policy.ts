import {
  hasOrganizationPermission,
  hasWorkspacePermission,
  type OrganizationPermissionKey,
  type OrganizationRoleKey,
  type WorkspacePermissionKey,
  type WorkspaceRoleKey,
} from '@skyos/domain';

import { OrganizationRole, WorkspaceRole } from '../generated/client/client';

function organizationRoleKey(role: OrganizationRole): OrganizationRoleKey {
  switch (role) {
    case OrganizationRole.OWNER:
      return 'owner';
    case OrganizationRole.ADMIN:
      return 'admin';
    case OrganizationRole.MEMBER:
      return 'member';
    case OrganizationRole.VIEWER:
      return 'viewer';
  }
}

function workspaceRoleKey(role: WorkspaceRole): WorkspaceRoleKey {
  switch (role) {
    case WorkspaceRole.OWNER:
      return 'owner';
    case WorkspaceRole.ADMIN:
      return 'admin';
    case WorkspaceRole.MEMBER:
      return 'member';
    case WorkspaceRole.VIEWER:
      return 'viewer';
  }
}

export function organizationRoleGrantsPermission(
  role: OrganizationRole,
  permission: OrganizationPermissionKey,
): boolean {
  return hasOrganizationPermission(organizationRoleKey(role), permission);
}

export function workspaceRoleGrantsPermission(
  role: WorkspaceRole,
  permission: WorkspacePermissionKey,
): boolean {
  return hasWorkspacePermission(workspaceRoleKey(role), permission);
}
