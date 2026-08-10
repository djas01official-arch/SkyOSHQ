'use server';

import { redirect } from 'next/navigation';

import {
  OrganizationAuthorizationError,
  OrganizationConflictError,
  OrganizationValidationError,
  createOrganizationForUser,
} from '../../../database/context/organization-creation';
import {
  WorkspaceAuthorizationError,
  WorkspaceConflictError,
  WorkspaceValidationError,
  createWorkspaceForOrganization,
} from '../../../database/context/workspace-creation';
import { getOrganizationContext } from '../../../database/context/organization-context';
import { getTenantManagementContext } from '../../../database/context/tenant-management';
import {
  archiveOrganization,
  archiveWorkspace,
  PrivilegedAuthorizationError,
  PrivilegedStateError,
  restoreOrganization,
  restoreWorkspace,
} from '../../../database/operations/privileged-operations';

import { unstable_update } from '@/auth';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getCurrentOrganizationContext } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type CreateWorkspaceState = {
  error: string | null;
};

export type CreateOrganizationState = {
  error: string | null;
};

export type TenantLifecycleState = {
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

function lifecycleError(error: unknown): TenantLifecycleState | null {
  if (error instanceof PrivilegedAuthorizationError) {
    return { error: 'You do not have permission to change this tenant lifecycle.' };
  }

  if (error instanceof PrivilegedStateError) {
    return { error: error.message };
  }

  return null;
}

async function persistResolvedContext(
  userId: string,
  selection: {
    activeOrganizationId?: string | null;
    activeWorkspaceId?: string | null;
  },
): Promise<void> {
  const context = await getOrganizationContext(prisma, userId, selection);

  await unstable_update({
    activeOrganizationId: context.activeOrganization?.id ?? null,
    activeWorkspaceId: context.activeWorkspace?.id ?? null,
  });
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

export async function createOrganizationAction(
  _previousState: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  const name = getFormString(formData, 'name');
  const slug = getFormString(formData, 'slug');
  const userId = await requireUserId();

  if (!name || !slug) {
    return { error: 'Enter an organization name and slug.' };
  }

  let organization: { id: string };

  try {
    organization = await createOrganizationForUser(prisma, userId, name, slug);
  } catch (error) {
    if (
      error instanceof OrganizationValidationError ||
      error instanceof OrganizationConflictError
    ) {
      return { error: error.message };
    }

    if (error instanceof OrganizationAuthorizationError) {
      return { error: 'Unable to create an organization.' };
    }

    throw error;
  }

  await unstable_update({
    activeOrganizationId: organization.id,
    activeWorkspaceId: null,
  });
  redirect('/settings');
}

export async function createWorkspaceAction(
  _previousState: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const name = getFormString(formData, 'name');
  const slug = getFormString(formData, 'slug');
  const userId = await requireUserId();
  const context = await getCurrentOrganizationContext();

  if (!name || !slug) {
    return { error: 'Enter a workspace name and slug.' };
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
      slug,
    );
  } catch (error) {
    if (error instanceof WorkspaceValidationError || error instanceof WorkspaceConflictError) {
      return { error: error.message };
    }

    if (error instanceof WorkspaceAuthorizationError) {
      return { error: 'You do not have permission to create a workspace here.' };
    }

    throw error;
  }

  await unstable_update({
    activeOrganizationId: context.activeOrganization.id,
    activeWorkspaceId: workspace.id,
  });
  redirect('/dashboard');
}

export async function archiveOrganizationAction(
  _previousState: TenantLifecycleState,
  formData: FormData,
): Promise<TenantLifecycleState> {
  const organizationId = getFormString(formData, 'organizationId');
  const userId = await requireUserId();
  const context = await getCurrentOrganizationContext();

  if (!organizationId || context?.activeOrganization?.id !== organizationId) {
    return { error: 'The active organization could not be resolved.' };
  }

  try {
    await archiveOrganization(prisma, userId, organizationId);
  } catch (error) {
    const state = lifecycleError(error);
    if (state) return state;
    throw error;
  }

  await persistResolvedContext(userId, {
    activeOrganizationId: organizationId,
    activeWorkspaceId: context.activeWorkspace?.id,
  });
  redirect('/settings');
}

export async function restoreOrganizationAction(
  _previousState: TenantLifecycleState,
  formData: FormData,
): Promise<TenantLifecycleState> {
  const organizationId = getFormString(formData, 'organizationId');
  const userId = await requireUserId();
  const context = await getCurrentOrganizationContext();
  const management = await getTenantManagementContext(prisma, userId, {
    activeOrganizationId: context?.activeOrganization?.id,
    activeWorkspaceId: context?.activeWorkspace?.id,
  });

  if (
    !organizationId ||
    !management.archivedOrganizations.some((organization) => organization.id === organizationId)
  ) {
    return { error: 'The archived organization could not be resolved.' };
  }

  try {
    await restoreOrganization(prisma, userId, organizationId);
  } catch (error) {
    const state = lifecycleError(error);
    if (state) return state;
    throw error;
  }

  await persistResolvedContext(userId, { activeOrganizationId: organizationId });
  redirect('/settings');
}

export async function archiveWorkspaceAction(
  _previousState: TenantLifecycleState,
  formData: FormData,
): Promise<TenantLifecycleState> {
  const workspaceId = getFormString(formData, 'workspaceId');
  const userId = await requireUserId();
  const context = await getCurrentOrganizationContext();

  if (!workspaceId || context?.activeWorkspace?.id !== workspaceId) {
    return { error: 'The active workspace could not be resolved.' };
  }

  try {
    await archiveWorkspace(prisma, userId, workspaceId);
  } catch (error) {
    const state = lifecycleError(error);
    if (state) return state;
    throw error;
  }

  await persistResolvedContext(userId, {
    activeOrganizationId: context.activeOrganization?.id,
    activeWorkspaceId: workspaceId,
  });
  redirect('/settings');
}

export async function restoreWorkspaceAction(
  _previousState: TenantLifecycleState,
  formData: FormData,
): Promise<TenantLifecycleState> {
  const workspaceId = getFormString(formData, 'workspaceId');
  const userId = await requireUserId();
  const context = await getCurrentOrganizationContext();
  const management = await getTenantManagementContext(prisma, userId, {
    activeOrganizationId: context?.activeOrganization?.id,
    activeWorkspaceId: context?.activeWorkspace?.id,
  });

  if (
    !workspaceId ||
    !management.archivedWorkspaces.some((workspace) => workspace.id === workspaceId)
  ) {
    return { error: 'The archived workspace could not be resolved.' };
  }

  try {
    await restoreWorkspace(prisma, userId, workspaceId);
  } catch (error) {
    const state = lifecycleError(error);
    if (state) return state;
    throw error;
  }

  await persistResolvedContext(userId, {
    activeOrganizationId: context?.activeOrganization?.id,
    activeWorkspaceId: workspaceId,
  });
  redirect('/settings');
}
