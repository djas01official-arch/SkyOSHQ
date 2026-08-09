export type PermissionScope = 'organization' | 'workspace';

export const ORGANIZATION_ROLE_KEYS = Object.freeze([
  'owner',
  'admin',
  'member',
  'viewer',
] as const);
export const WORKSPACE_ROLE_KEYS = Object.freeze(['owner', 'admin', 'member', 'viewer'] as const);

export type OrganizationRoleKey = (typeof ORGANIZATION_ROLE_KEYS)[number];
export type WorkspaceRoleKey = (typeof WORKSPACE_ROLE_KEYS)[number];

export const ORGANIZATION_PERMISSION_KEYS = Object.freeze([
  'organization.read',
  'organization.update',
  'organization.archive',
  'organization.transfer_ownership',
  'organization.members.read',
  'organization.members.manage',
  'organization.workspaces.read',
  'organization.workspaces.create',
  'organization.workspaces.manage',
] as const);

export const WORKSPACE_PERMISSION_KEYS = Object.freeze([
  'workspace.read',
  'workspace.update',
  'workspace.archive',
  'workspace.members.read',
  'workspace.members.manage',
  'knowledge.read',
  'knowledge.write',
  'tasks.read',
  'tasks.write',
  'ai.use',
] as const);

export type OrganizationPermissionKey = (typeof ORGANIZATION_PERMISSION_KEYS)[number];
export type WorkspacePermissionKey = (typeof WORKSPACE_PERMISSION_KEYS)[number];

export type PermissionDefinition<Scope extends PermissionScope, Key extends string> = Readonly<{
  description: string;
  key: Key;
  scope: Scope;
}>;

export type RoleDefinition<
  Scope extends PermissionScope,
  RoleKey extends string,
  PermissionKey,
> = Readonly<{
  description: string;
  key: RoleKey;
  permissions: readonly PermissionKey[];
  scope: Scope;
}>;

function definePermission<Scope extends PermissionScope, Key extends string>(
  scope: Scope,
  key: Key,
  description: string,
): PermissionDefinition<Scope, Key> {
  return Object.freeze({ description, key, scope });
}

function defineRole<Scope extends PermissionScope, RoleKey extends string, PermissionKey>(
  scope: Scope,
  key: RoleKey,
  description: string,
  permissions: readonly PermissionKey[],
): RoleDefinition<Scope, RoleKey, PermissionKey> {
  return Object.freeze({
    description,
    key,
    permissions: Object.freeze([...permissions]),
    scope,
  });
}

export const organizationPermissions = Object.freeze({
  'organization.read': definePermission(
    'organization',
    'organization.read',
    'Read organization profile and directory metadata.',
  ),
  'organization.update': definePermission(
    'organization',
    'organization.update',
    'Update organization profile and settings.',
  ),
  'organization.archive': definePermission(
    'organization',
    'organization.archive',
    'Archive or restore the organization.',
  ),
  'organization.transfer_ownership': definePermission(
    'organization',
    'organization.transfer_ownership',
    'Transfer organization owner authority.',
  ),
  'organization.members.read': definePermission(
    'organization',
    'organization.members.read',
    'Read organization memberships.',
  ),
  'organization.members.manage': definePermission(
    'organization',
    'organization.members.manage',
    'Manage non-owner organization memberships.',
  ),
  'organization.workspaces.read': definePermission(
    'organization',
    'organization.workspaces.read',
    'Enumerate all workspace metadata in the organization.',
  ),
  'organization.workspaces.create': definePermission(
    'organization',
    'organization.workspaces.create',
    'Create a workspace in the organization.',
  ),
  'organization.workspaces.manage': definePermission(
    'organization',
    'organization.workspaces.manage',
    'Administer workspace containers and memberships without content access.',
  ),
} satisfies Record<
  OrganizationPermissionKey,
  PermissionDefinition<'organization', OrganizationPermissionKey>
>);

export const workspacePermissions = Object.freeze({
  'workspace.read': definePermission('workspace', 'workspace.read', 'Read workspace metadata.'),
  'workspace.update': definePermission(
    'workspace',
    'workspace.update',
    'Update workspace metadata and settings.',
  ),
  'workspace.archive': definePermission(
    'workspace',
    'workspace.archive',
    'Archive or restore the workspace.',
  ),
  'workspace.members.read': definePermission(
    'workspace',
    'workspace.members.read',
    'Read workspace memberships.',
  ),
  'workspace.members.manage': definePermission(
    'workspace',
    'workspace.members.manage',
    'Manage non-owner workspace memberships.',
  ),
  'knowledge.read': definePermission(
    'workspace',
    'knowledge.read',
    'Read Knowledge resources in the workspace.',
  ),
  'knowledge.write': definePermission(
    'workspace',
    'knowledge.write',
    'Create or modify Knowledge resources in the workspace.',
  ),
  'tasks.read': definePermission(
    'workspace',
    'tasks.read',
    'Read task resources in the workspace.',
  ),
  'tasks.write': definePermission(
    'workspace',
    'tasks.write',
    'Create or modify task resources in the workspace.',
  ),
  'ai.use': definePermission('workspace', 'ai.use', 'Use workspace-scoped AI capabilities.'),
} satisfies Record<
  WorkspacePermissionKey,
  PermissionDefinition<'workspace', WorkspacePermissionKey>
>);

export const organizationRoles = Object.freeze({
  owner: defineRole(
    'organization',
    'owner',
    'Full organization authority.',
    ORGANIZATION_PERMISSION_KEYS,
  ),
  admin: defineRole('organization', 'admin', 'Organization administration without ownership.', [
    'organization.read',
    'organization.update',
    'organization.members.read',
    'organization.members.manage',
    'organization.workspaces.read',
    'organization.workspaces.create',
    'organization.workspaces.manage',
  ]),
  member: defineRole('organization', 'member', 'Standard organization membership.', [
    'organization.read',
  ]),
  viewer: defineRole('organization', 'viewer', 'Read-only organization membership.', [
    'organization.read',
  ]),
} satisfies Record<
  OrganizationRoleKey,
  RoleDefinition<'organization', OrganizationRoleKey, OrganizationPermissionKey>
>);

export const workspaceRoles = Object.freeze({
  owner: defineRole('workspace', 'owner', 'Full workspace authority.', WORKSPACE_PERMISSION_KEYS),
  admin: defineRole('workspace', 'admin', 'Workspace administration without archive authority.', [
    'workspace.read',
    'workspace.update',
    'workspace.members.read',
    'workspace.members.manage',
    'knowledge.read',
    'knowledge.write',
    'tasks.read',
    'tasks.write',
    'ai.use',
  ]),
  member: defineRole('workspace', 'member', 'Standard workspace contributor.', [
    'workspace.read',
    'knowledge.read',
    'knowledge.write',
    'tasks.read',
    'tasks.write',
    'ai.use',
  ]),
  viewer: defineRole('workspace', 'viewer', 'Read-only workspace participant.', [
    'workspace.read',
    'knowledge.read',
    'tasks.read',
  ]),
} satisfies Record<
  WorkspaceRoleKey,
  RoleDefinition<'workspace', WorkspaceRoleKey, WorkspacePermissionKey>
>);

export type RoleReference =
  | Readonly<{ key: OrganizationRoleKey; scope: 'organization' }>
  | Readonly<{ key: WorkspaceRoleKey; scope: 'workspace' }>;

export type PermissionReference =
  | Readonly<{ key: OrganizationPermissionKey; scope: 'organization' }>
  | Readonly<{ key: WorkspacePermissionKey; scope: 'workspace' }>;

export function hasOrganizationPermission(
  role: OrganizationRoleKey,
  permission: OrganizationPermissionKey,
): boolean {
  const definition: RoleDefinition<'organization', OrganizationRoleKey, OrganizationPermissionKey> =
    organizationRoles[role];

  return definition.permissions.includes(permission);
}

export function hasWorkspacePermission(
  role: WorkspaceRoleKey,
  permission: WorkspacePermissionKey,
): boolean {
  const definition: RoleDefinition<'workspace', WorkspaceRoleKey, WorkspacePermissionKey> =
    workspaceRoles[role];

  return definition.permissions.includes(permission);
}

export function roleGrantsPermission(
  role: RoleReference,
  permission: PermissionReference,
): boolean {
  if (role.scope === 'organization') {
    return (
      permission.scope === 'organization' && hasOrganizationPermission(role.key, permission.key)
    );
  }

  return permission.scope === 'workspace' && hasWorkspacePermission(role.key, permission.key);
}
