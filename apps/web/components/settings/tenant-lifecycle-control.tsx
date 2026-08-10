'use client';

import { useActionState, useState } from 'react';

import {
  archiveOrganizationAction,
  archiveWorkspaceAction,
  restoreOrganizationAction,
  restoreWorkspaceAction,
  type TenantLifecycleState,
} from '@/app/context-actions';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export type TenantLifecycleOperation =
  'archive-organization' | 'restore-organization' | 'archive-workspace' | 'restore-workspace';

type TenantLifecycleControlProps = Readonly<{
  disabled?: boolean;
  id: string;
  name: string;
  operation: TenantLifecycleOperation;
}>;

const initialState: TenantLifecycleState = { error: null };
const actions = {
  'archive-organization': archiveOrganizationAction,
  'archive-workspace': archiveWorkspaceAction,
  'restore-organization': restoreOrganizationAction,
  'restore-workspace': restoreWorkspaceAction,
};

function lifecycleCopy(operation: TenantLifecycleOperation, name: string) {
  switch (operation) {
    case 'archive-organization':
      return {
        buttonLabel: 'Archive organization',
        description: `Archive ${name} and block all normal organization and workspace activity. This is not deletion.`,
        fieldName: 'organizationId',
        pendingLabel: 'Archiving...',
        title: 'Archive organization?',
        variant: 'danger' as const,
      };
    case 'restore-organization':
      return {
        buttonLabel: 'Restore',
        description: `Restore ${name} to active status. Existing membership rules still apply.`,
        fieldName: 'organizationId',
        pendingLabel: 'Restoring...',
        title: 'Restore organization?',
        variant: 'primary' as const,
      };
    case 'archive-workspace':
      return {
        buttonLabel: 'Archive workspace',
        description: `Archive ${name} and block normal product activity in it. This is not deletion.`,
        fieldName: 'workspaceId',
        pendingLabel: 'Archiving...',
        title: 'Archive workspace?',
        variant: 'danger' as const,
      };
    case 'restore-workspace':
      return {
        buttonLabel: 'Restore',
        description: `Restore ${name} to active status without changing its organization or memberships.`,
        fieldName: 'workspaceId',
        pendingLabel: 'Restoring...',
        title: 'Restore workspace?',
        variant: 'primary' as const,
      };
  }
}

export function TenantLifecycleControl({
  disabled = false,
  id,
  name,
  operation,
}: TenantLifecycleControlProps) {
  const [open, setOpen] = useState(false);
  const copy = lifecycleCopy(operation, name);
  const [state, formAction, pending] = useActionState(actions[operation], initialState);
  const formId = `tenant-lifecycle-${operation}-${id}`;

  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)} size="small" variant={copy.variant}>
        {copy.buttonLabel}
      </Button>
      <Dialog
        description={copy.description}
        footer={
          <div className="flex justify-end gap-3">
            <Button disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} form={formId} type="submit" variant={copy.variant}>
              {pending ? copy.pendingLabel : copy.buttonLabel}
            </Button>
          </div>
        }
        onOpenChange={(nextOpen) => {
          if (!pending) setOpen(nextOpen);
        }}
        open={open}
        title={copy.title}
      >
        <form action={formAction} data-lifecycle-operation={operation} id={formId}>
          <input name={copy.fieldName} type="hidden" value={id} />
          <p className="text-sm leading-6 text-muted-foreground">
            This transition is audited. Hard deletion remains unsupported, and the current slug
            policy is unchanged.
          </p>
          {state.error ? (
            <p aria-live="polite" className="mt-4 text-sm leading-6 text-danger">
              {state.error}
            </p>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}
