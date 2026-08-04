'use client';

import { useActionState, useState } from 'react';

import type { OrganizationContext } from '../../../../database/context/organization-context';

import {
  createWorkspaceAction,
  selectOrganizationAction,
  selectWorkspaceAction,
  type CreateWorkspaceState,
} from '@/app/context-actions';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

type ContextSwitcherProps = Readonly<{
  context: OrganizationContext | null;
}>;

const initialCreateWorkspaceState: CreateWorkspaceState = { error: null };

export function OrganizationSwitcher({ context }: ContextSwitcherProps) {
  if (!context?.activeOrganization) {
    return (
      <span className="rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
        No active organization
      </span>
    );
  }

  return (
    <form action={selectOrganizationAction}>
      <label className="sr-only" htmlFor="organization-switcher">
        Active organization
      </label>
      <select
        className="h-8 max-w-44 appearance-none rounded-control border border-border bg-surface py-1 pl-2.5 pr-7 text-xs font-medium text-foreground outline-none transition-colors hover:bg-surface-raised focus:border-accent focus:ring-2 focus:ring-accent/20"
        defaultValue={context.activeOrganization.id}
        id="organization-switcher"
        name="organizationId"
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {context.organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
    </form>
  );
}

export function WorkspaceSwitcher({ context }: ContextSwitcherProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [state, createFormAction, isCreating] = useActionState(
    createWorkspaceAction,
    initialCreateWorkspaceState,
  );

  if (!context?.activeOrganization) {
    return null;
  }

  return (
    <section aria-label="Workspace context" className="space-y-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Active workspace
        </p>
        <form action={selectWorkspaceAction} className="mt-2">
          <label className="sr-only" htmlFor="workspace-switcher">
            Active workspace
          </label>
          <select
            className="h-10 w-full rounded-control border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors hover:bg-surface-raised focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-70"
            defaultValue={context.activeWorkspace?.id ?? ''}
            disabled={context.workspaces.length === 0}
            id="workspace-switcher"
            name="workspaceId"
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            {context.workspaces.length === 0 ? (
              <option value="">No workspaces available</option>
            ) : null}
            {context.workspaces.map((workspace) => (
              <option
                disabled={!workspace.hasActiveMembership}
                key={workspace.id}
                value={workspace.id}
              >
                {workspace.name}
                {workspace.hasActiveMembership ? '' : ' (no workspace access)'}
              </option>
            ))}
          </select>
        </form>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {context.activeWorkspace
            ? `Working in ${context.activeWorkspace.name}.`
            : 'Select a workspace where you have access.'}
        </p>
      </div>

      {context.canCreateWorkspace ? (
        <div>
          <Button
            aria-expanded={isCreateOpen}
            className="w-full"
            onClick={() => setIsCreateOpen((isOpen) => !isOpen)}
            size="small"
            variant="secondary"
          >
            <Icon className="size-3.5" name="plus" />
            New workspace
          </Button>
          {isCreateOpen ? (
            <form action={createFormAction} className="mt-3 space-y-2">
              <label className="sr-only" htmlFor="workspace-name">
                Workspace name
              </label>
              <input
                autoComplete="off"
                className="h-9 w-full rounded-control border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent focus:ring-2 focus:ring-accent/20"
                id="workspace-name"
                maxLength={120}
                name="name"
                placeholder="Workspace name"
                required
              />
              {state.error ? (
                <p aria-live="polite" className="text-xs leading-5 text-danger">
                  {state.error}
                </p>
              ) : null}
              <Button
                className="w-full"
                disabled={isCreating}
                size="small"
                type="submit"
                variant="primary"
              >
                {isCreating ? 'Creating…' : 'Create workspace'}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
