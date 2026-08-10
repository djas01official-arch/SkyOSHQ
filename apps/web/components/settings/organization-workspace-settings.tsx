'use client';

import { useActionState } from 'react';

import type { OrganizationContext } from '../../../../database/context/organization-context';
import type { TenantManagementContext } from '../../../../database/context/tenant-management';

import { createOrganizationAction, type CreateOrganizationState } from '@/app/context-actions';
import { TenantLifecycleControl } from '@/components/settings/tenant-lifecycle-control';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';

const initialCreateOrganizationState: CreateOrganizationState = { error: null };

function roleLabel(role: string | null): string {
  if (!role) return 'Directory only';
  return role.charAt(0) + role.slice(1).toLowerCase();
}

type OrganizationWorkspaceSettingsProps = Readonly<{
  context: OrganizationContext | null;
  management: TenantManagementContext;
}>;

export function OrganizationWorkspaceSettings({
  context,
  management,
}: OrganizationWorkspaceSettingsProps) {
  const [state, createOrganization, isCreating] = useActionState(
    createOrganizationAction,
    initialCreateOrganizationState,
  );
  const activeOrganization = context?.activeOrganization;
  const activeWorkspace = context?.activeWorkspace;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        description="Review trusted tenant context and manage the minimal organization boundaries used by SkyOS."
        eyebrow="Tenant context"
        title="Organizations and workspaces"
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              description="Membership roles shown here are resolved from the database on every request."
              title="Current organization"
            />
            {activeOrganization ? (
              <dl className="mt-6 grid gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Name
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-foreground">
                    {activeOrganization.name}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Slug
                  </dt>
                  <dd className="mt-1 font-mono text-sm text-foreground">
                    {activeOrganization.slug}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Your role
                  </dt>
                  <dd className="mt-1">
                    <Badge tone="accent">{roleLabel(activeOrganization.role)}</Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </dt>
                  <dd className="mt-1">
                    <Badge tone="success">Active</Badge>
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="mt-6">
                <EmptyState
                  description="Create or restore an organization to establish an active tenant boundary."
                  icon="grid"
                  title="No active organization"
                />
              </div>
            )}
            {activeOrganization ? (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <p className="text-xs leading-5 text-muted-foreground">
                  {management.canArchiveOrganization
                    ? 'Archiving preserves this tenant and its history for later restoration.'
                    : 'Only an active organization owner can archive this organization.'}
                </p>
                <TenantLifecycleControl
                  disabled={!management.canArchiveOrganization}
                  id={activeOrganization.id}
                  name={activeOrganization.name}
                  operation="archive-organization"
                />
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              description="Organization owners and admins see the directory. Content access still requires an active workspace membership."
              title="Discoverable workspaces"
            />
            {context?.workspaces.length ? (
              <ul className="mt-6 divide-y divide-border rounded-control border border-border">
                {context.workspaces.map((workspace) => (
                  <li className="flex items-center justify-between gap-4 p-4" key={workspace.id}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {workspace.name}
                      </p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {workspace.slug}
                      </p>
                    </div>
                    <Badge tone={workspace.hasActiveMembership ? 'success' : 'neutral'}>
                      {roleLabel(workspace.role)}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-6">
                <EmptyState
                  description="Use the workspace control in the sidebar when your organization role permits creation."
                  icon="grid"
                  title="No discoverable workspaces"
                />
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              description="Only workspaces backed by your effective active membership can become content context."
              title="Current workspace"
            />
            {activeWorkspace ? (
              <dl className="mt-6 grid gap-4 sm:grid-cols-4">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Name
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-foreground">
                    {activeWorkspace.name}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Slug
                  </dt>
                  <dd className="mt-1 font-mono text-sm text-foreground">{activeWorkspace.slug}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Your role
                  </dt>
                  <dd className="mt-1">
                    <Badge tone="success">{roleLabel(activeWorkspace.role)}</Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </dt>
                  <dd className="mt-1">
                    <Badge tone="success">Active</Badge>
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-6 text-sm leading-6 text-muted-foreground">
                No effective workspace is selected. Directory visibility does not grant content
                access.
              </p>
            )}
            {activeWorkspace ? (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
                <p className="text-xs leading-5 text-muted-foreground">
                  {management.canArchiveWorkspace
                    ? 'Archived workspaces leave normal product context but retain their data and memberships.'
                    : 'Workspace archive authority is required for this action.'}
                </p>
                <TenantLifecycleControl
                  disabled={!management.canArchiveWorkspace}
                  id={activeWorkspace.id}
                  name={activeWorkspace.name}
                  operation="archive-workspace"
                />
              </div>
            ) : null}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              description="The creator becomes the first active organization owner atomically."
              title="Create organization"
            />
            <form action={createOrganization} className="mt-6 space-y-4">
              <div>
                <label className="text-sm font-medium text-foreground" htmlFor="organization-name">
                  Organization name
                </label>
                <Input
                  autoComplete="organization"
                  className="mt-2"
                  id="organization-name"
                  maxLength={120}
                  name="name"
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground" htmlFor="organization-slug">
                  Organization slug
                </label>
                <Input
                  autoCapitalize="none"
                  autoComplete="off"
                  className="mt-2"
                  id="organization-slug"
                  maxLength={80}
                  name="slug"
                  placeholder="operations-emea"
                  required
                  spellCheck={false}
                />
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Normalized to lowercase letters, numbers, and hyphens.
                </p>
              </div>
              {state.error ? (
                <p aria-live="polite" className="text-sm leading-6 text-danger">
                  {state.error}
                </p>
              ) : null}
              <Button disabled={isCreating} type="submit" variant="primary">
                {isCreating ? 'Creatingâ€¦' : 'Create organization'}
              </Button>
            </form>
          </Card>

          {management.archivedOrganizations.length ? (
            <Card variant="muted">
              <CardHeader
                description="Archived organizations are management targets only and never active product context."
                title="Archived organizations"
              />
              <ul className="mt-5 space-y-3">
                {management.archivedOrganizations.map((organization) => (
                  <li
                    className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface p-3"
                    key={organization.id}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {organization.name}
                      </p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {organization.slug}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone="warning">Archived</Badge>
                      <TenantLifecycleControl
                        id={organization.id}
                        name={organization.name}
                        operation="restore-organization"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {management.archivedWorkspaces.length ? (
            <Card variant="muted">
              <CardHeader
                description="Restoration preserves the original organization boundary and memberships."
                title="Archived workspaces"
              />
              <ul className="mt-5 space-y-3">
                {management.archivedWorkspaces.map((workspace) => (
                  <li
                    className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface p-3"
                    key={workspace.id}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {workspace.name}
                      </p>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {workspace.slug}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone="warning">Archived</Badge>
                      <TenantLifecycleControl
                        id={workspace.id}
                        name={workspace.name}
                        operation="restore-workspace"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
