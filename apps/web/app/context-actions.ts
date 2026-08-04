'use server';

import { redirect } from 'next/navigation';

import {
  WorkspaceAuthorizationError,
  WorkspaceValidationError,
  createWorkspaceForOrganization,
} from '../../../database/context/workspace-creation';
import { getOrganizationContext } from '../../../database/context/organization-context';

import { unstable_update } from '@/auth';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getCurrentOrganizationContext } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type CreateWorkspaceState = {
  error: string | null;
};

function getFormString(formData: FormData, fieldName: string): string | null {
  const value = formData.get(fieldName);

  return typeof value === 'string' ? value : null;
}

async function requireUserId(): Promise<string> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  return user.id;
}

export async function selectOrganizationAction(formData: FormData): Promise<void> {
  const organizationId = getFormString(formData, 'organizationId');
  const userId = await requireUserId();

  if (!organizationId) {
    redirect('/dashboard');
  }

  const context = await getOrganizationContext(prisma, userId, {
    activeOrganizationId: organizationId,
  });

  if (context.activeOrganization?.id !== organizationId) {
    redirect('/dashboard');
  }

  await unstable_update({
    activeOrganizationId: context.activeOrganization.id,
    activeWorkspaceId: context.activeWorkspace?.id ?? null,
  });
  redirect('/dashboard');
}

export async function selectWorkspaceAction(formData: FormData): Promise<void> {
  const workspaceId = getFormString(formData, 'workspaceId');
  await requireUserId();
  const context = await getCurrentOrganizationContext();

  if (!workspaceId || !context?.activeOrganization) {
    redirect('/dashboard');
  }

  const workspace = context.workspaces.find(
    (candidate) => candidate.id === workspaceId && candidate.hasActiveMembership,
  );

  if (!workspace) {
    redirect('/dashboard');
  }

  await unstable_update({
    activeOrganizationId: context.activeOrganization.id,
    activeWorkspaceId: workspace.id,
  });
  redirect('/dashboard');
}

export async function createWorkspaceAction(
  _previousState: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const name = getFormString(formData, 'name');
  const userId = await requireUserId();
  const context = await getCurrentOrganizationContext();

  if (!name) {
    return { error: 'Enter a workspace name.' };
  }

  if (!context?.activeOrganization || !context.canCreateWorkspace) {
    return { error: 'You do not have permission to create a workspace here.' };
  }

  let workspace: { id: string };

  try {
    workspace = await createWorkspaceForOrganization(
      prisma,
      userId,
      context.activeOrganization.id,
      name,
    );
  } catch (error) {
    if (error instanceof WorkspaceValidationError || error instanceof WorkspaceAuthorizationError) {
      return { error: error.message };
    }

    throw error;
  }

  await unstable_update({
    activeOrganizationId: context.activeOrganization.id,
    activeWorkspaceId: workspace.id,
  });
  redirect('/dashboard');
}
