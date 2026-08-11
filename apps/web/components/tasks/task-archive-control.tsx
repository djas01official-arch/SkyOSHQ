'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { archiveTaskAction, type TaskActionState } from '@/app/tasks/actions';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

type TaskArchiveControlProps = Readonly<{
  expectedUpdatedAt: string;
  taskId: string;
  title: string;
}>;

const initialState: TaskActionState = { conflict: false, error: null, values: null };

export function TaskArchiveControl({ expectedUpdatedAt, taskId, title }: TaskArchiveControlProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(archiveTaskAction, initialState);
  const formId = `archive-task-${taskId}`;

  return (
    <>
      <Button onClick={() => setOpen(true)} size="small" variant="danger">
        Archive
      </Button>
      <Dialog
        description={`Archive “${title}” and remove it from the active Task list.`}
        footer={
          <div className="flex justify-end gap-3">
            <Button disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} form={formId} type="submit" variant="danger">
              {pending ? 'Archiving…' : 'Archive Task'}
            </Button>
          </div>
        }
        onOpenChange={(nextOpen) => {
          if (!pending) setOpen(nextOpen);
        }}
        open={open}
        title="Archive Task?"
      >
        <form action={formAction} data-task-operation="archive" id={formId}>
          <input name="expectedUpdatedAt" type="hidden" value={expectedUpdatedAt} />
          <input name="taskId" type="hidden" value={taskId} />
          <p className="text-sm leading-6 text-muted-foreground">
            This action is audited. Restore and hard deletion are not available in Tasks MVP v1.
          </p>
          {state.error ? (
            <div
              aria-live="polite"
              className="mt-4 text-sm leading-6 text-danger"
              data-task-conflict={state.conflict ? 'true' : undefined}
              role="alert"
            >
              <p>{state.error}</p>
              {state.conflict ? (
                <Link
                  className="mt-2 inline-block font-semibold underline"
                  href={`/tasks/${taskId}`}
                >
                  Reload the latest Task
                </Link>
              ) : null}
            </div>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}
