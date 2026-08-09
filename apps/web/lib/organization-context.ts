import {
  getOrganizationContext,
  type OrganizationContext,
} from '../../../database/context/organization-context';
import { WorkspaceRole } from '../../../database/generated/client/client';
import { hasWorkspacePermission, type WorkspacePermissionKey } from '@skyos/domain';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { getCurrentUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/prisma';

/** Resolves signed session preferences against the current membership state. */
export async function getCurrentOrganizationContext(): Promise<OrganizationContext | null> {
  const [session, user] = await Promise.all([auth(), getCurrentUser()]);

  if (!user) {
    return null;
  }

  return getOrganizationContext(prisma, user.id, {
    activeOrganizationId: session?.activeOrganizationId,
    activeWorkspaceId: session?.activeWorkspaceId,
  });
}

export type WorkspaceCapability = WorkspacePermissionKey;

function getWorkspaceRoleKey(role: WorkspaceRole): 'owner' | 'admin' | 'member' | 'viewer' {
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

export function hasWorkspaceCapability(
  role: WorkspaceRole | null,
  capability: WorkspaceCapability,
): boolean {
  if (!role) {
    return false;
  }

  return hasWorkspacePermission(getWorkspaceRoleKey(role), capability);
}

/** Enforces the selected workspace's effective membership and role grant. */
export async function requireWorkspaceCapability(
  capability: WorkspaceCapability,
): Promise<OrganizationContext> {
  const context = await getCurrentOrganizationContext();

  if (
    !context?.activeWorkspace ||
    !hasWorkspaceCapability(context.activeWorkspace.role, capability)
  ) {
    redirect('/dashboard');
  }

  return context;
}
