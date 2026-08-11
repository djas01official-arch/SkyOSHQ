import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  TaskNotFoundError,
  getTask,
  isTaskAssigneeEffective,
  serializeTaskConcurrencyToken,
} from '../../../../../database/tasks/tasks';

import { TaskArchiveControl } from '@/components/tasks/task-archive-control';
import {
  formatTaskDueDate,
  TaskPriorityBadge,
  TaskStatusIndicator,
  taskUserLabel,
} from '@/components/tasks/task-display';
import { buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type TaskPageProps = Readonly<{ params: Promise<{ taskId: string }> }>;

export default async function TaskPage({ params }: TaskPageProps) {
  const [{ taskId }, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('tasks.read'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) notFound();

  let task;
  try {
    task = await getTask(prisma, user.id, workspace.id, taskId);
  } catch (error) {
    if (error instanceof TaskNotFoundError) notFound();
    throw error;
  }

  const canWrite = hasWorkspaceCapability(workspace.role, 'tasks.write');
  const assignee = task.assignee ? taskUserLabel(task.assignee) : 'Unassigned';
  const assigneeUnavailable = task.assignee && !isTaskAssigneeEffective(task);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col justify-between gap-5 border-b border-border pb-7 sm:flex-row sm:items-start">
        <div>
          <Link className="text-sm font-medium text-accent hover:underline" href="/tasks">
            Tasks
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {task.title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Created by {taskUserLabel(task.createdBy)} · Updated {task.updatedAt.toLocaleString()}
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className={buttonClassName({ size: 'small', variant: 'secondary' })}
              href={`/tasks/${task.id}/edit`}
            >
              Edit
            </Link>
            <TaskArchiveControl
              expectedUpdatedAt={serializeTaskConcurrencyToken(task.updatedAt)}
              taskId={task.id}
              title={task.title}
            />
          </div>
        ) : null}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card variant="muted">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Status
          </p>
          <div className="mt-3">
            <TaskStatusIndicator status={task.status} />
          </div>
        </Card>
        <Card variant="muted">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Priority
          </p>
          <div className="mt-3">
            <TaskPriorityBadge priority={task.priority} />
          </div>
        </Card>
        <Card variant="muted">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Assignee
          </p>
          <p className="mt-3 text-sm font-medium text-foreground">{assignee}</p>
          {assigneeUnavailable ? (
            <p className="mt-2 text-xs leading-5 text-warning">
              This historical assignee no longer has effective workspace access.
            </p>
          ) : null}
        </Card>
        <Card variant="muted">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Due date
          </p>
          <p className="mt-3 text-sm font-medium text-foreground">
            {task.dueAt ? formatTaskDueDate(task.dueAt) : 'No due date'}
          </p>
        </Card>
      </div>

      <Card className="mt-4">
        <h2 className="text-base font-semibold text-foreground">Description</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
          {task.description ?? 'No description provided.'}
        </p>
      </Card>
    </div>
  );
}
