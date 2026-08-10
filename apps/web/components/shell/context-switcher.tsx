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
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

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
      <Select
        className="h-8 max-w-44 py-1 pl-2.5 pr-7 text-xs font-semibold"
        defaultValue={context.activeOrganization.id}
        id="organization-switcher"
        name="organizationId"
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {context.organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name} ({organization.role.toLowerCase()})
          </option>
        ))}
      </Select>
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
          <Select
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
                {workspace.hasActiveMembership
                  ? ` (${workspace.role?.toLowerCase()})`
                  : ' (directory only)'}
              </option>
            ))}
          </Select>
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
              <Input
                autoComplete="off"
                className="h-9"
                id="workspace-name"
                maxLength={120}
                name="name"
                placeholder="Workspace name"
                required
              />
              <label className="sr-only" htmlFor="workspace-slug">
                Workspace slug
              </label>
              <Input
                autoCapitalize="none"
                autoComplete="off"
                className="h-9"
                id="workspace-slug"
                maxLength={80}
                name="slug"
                placeholder="workspace-slug"
                required
                spellCheck={false}
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
