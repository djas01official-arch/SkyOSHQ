'use client';

import { useActionState } from 'react';

import type { TaskActionState } from '@/app/tasks/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type AssigneeOption = Readonly<{
  displayName: string | null;
  email: string | null;
  id: string;
}>;

type TaskFormProps = Readonly<{
  action: (previousState: TaskActionState, formData: FormData) => Promise<TaskActionState>;
  assigneeUserId?: string;
  assignees: readonly AssigneeOption[];
  description?: string;
  dueAt?: string;
  kind: 'create' | 'edit';
  priority?: string;
  status?: string;
  submitLabel: string;
  taskId?: string;
  title?: string;
}>;

const initialState: TaskActionState = { error: null };

function assigneeLabel(assignee: AssigneeOption): string {
  return assignee.displayName ?? assignee.email ?? 'Unnamed workspace member';
}

export function TaskForm({
  action,
  assigneeUserId = '',
  assignees,
  description = '',
  dueAt = '',
  kind,
  priority = 'MEDIUM',
  status = 'TODO',
  submitLabel,
  taskId,
  title = '',
}: TaskFormProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-5" data-task-form={kind}>
      {taskId ? <input name="taskId" type="hidden" value={taskId} /> : null}
      <label className="block">
        <span className="text-sm font-medium text-foreground">Title</span>
        <Input
          className="mt-2 h-11"
          defaultValue={title}
          maxLength={200}
          name="title"
          placeholder="Task title"
          required
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-foreground">Description</span>
        <Textarea
          className="mt-2 min-h-32"
          defaultValue={description}
          maxLength={10000}
          name="description"
          placeholder="Optional context, outcome, or next step"
        />
      </label>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-foreground">Status</span>
          <Select className="mt-2 h-11" defaultValue={status} name="status">
            <option value="TODO">To do</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="DONE">Done</option>
          </Select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-foreground">Priority</span>
          <Select className="mt-2 h-11" defaultValue={priority} name="priority">
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
          </Select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-foreground">Assignee</span>
          <Select className="mt-2 h-11" defaultValue={assigneeUserId} name="assigneeUserId">
            <option value="">Unassigned</option>
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assigneeLabel(assignee)}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-foreground">Due date</span>
          <Input className="mt-2 h-11" defaultValue={dueAt} name="dueAt" type="date" />
        </label>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Due dates are calendar dates. SkyOS stores them without a time or timezone shift.
      </p>
      {state.error ? (
        <p
          aria-live="polite"
          className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={isPending} type="submit" variant="primary">
          {isPending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
