import {
  getOrganizationContext,
  type OrganizationContext,
} from '../../../database/context/organization-context';
import { WorkspaceRole } from '../../../database/generated/client/client';
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

export type WorkspaceCapability = 'ai.use' | 'knowledge.read' | 'knowledge.write' | 'tasks.read';

export function hasWorkspaceCapability(
  role: WorkspaceRole | null,
  capability: WorkspaceCapability,
): boolean {
  if (!role) {
    return false;
  }

  if (capability === 'ai.use') {
    return role !== WorkspaceRole.VIEWER;
  }

  if (capability === 'knowledge.write') {
    return role !== WorkspaceRole.VIEWER;
  }

  return true;
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
