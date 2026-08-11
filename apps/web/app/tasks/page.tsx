import Link from 'next/link';

import {
  TASK_LIST_LIMIT,
  isTaskAssigneeEffective,
  listTasks,
} from '../../../../database/tasks/tasks';
import { TaskStatus } from '../../../../database/generated/client/client';

import {
  formatTaskDueDate,
  TaskPriorityBadge,
  TaskStatusIndicator,
  taskUserLabel,
} from '@/components/tasks/task-display';
import { buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export default async function TasksPage() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('tasks.read'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;

  const tasks = await listTasks(prisma, user.id, workspace.id);
  const canWrite = hasWorkspaceCapability(workspace.role, 'tasks.write');
  const incompleteCount = tasks.filter(({ status }) => status !== TaskStatus.DONE).length;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        action={
          canWrite ? (
            <Link className={buttonClassName({ variant: 'primary' })} href="/tasks/new">
              <Icon className="size-4" name="plus" />
              New Task
            </Link>
          ) : null
        }
        description={`Workspace-scoped execution for ${workspace.name}.`}
        eyebrow="Workspace Tasks"
        title="Tasks"
      />

      {tasks.length ? (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {incompleteCount} incomplete · {tasks.length} active
            {tasks.length === TASK_LIST_LIMIT ? '+' : ''}
          </p>
          <div className="grid gap-3">
            {tasks.map((task) => {
              const assignee = task.assignee
                ? `${taskUserLabel(task.assignee)}${isTaskAssigneeEffective(task) ? '' : ' · Unavailable'}`
                : 'Unassigned';

              return (
                <Link href={`/tasks/${task.id}`} key={task.id}>
                  <Card className="transition-colors hover:border-accent/50 hover:bg-surface-raised">
                    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold text-foreground">
                          {task.title}
                        </h2>
                        {task.description ? (
                          <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                            {task.description}
                          </p>
                        ) : null}
                        <p className="mt-3 text-xs text-muted-foreground">
                          {assignee} ·{' '}
                          {task.dueAt ? `Due ${formatTaskDueDate(task.dueAt)}` : 'No due date'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <TaskStatusIndicator status={task.status} />
                        <TaskPriorityBadge priority={task.priority} />
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
          {tasks.length === TASK_LIST_LIMIT ? (
            <p className="mt-5 text-xs leading-5 text-muted-foreground">
              Showing the first {TASK_LIST_LIMIT} active Tasks in the documented workspace order.
            </p>
          ) : null}
        </>
      ) : (
        <Card className="grid min-h-72 place-items-center">
          <EmptyState
            action={
              canWrite ? (
                <Link className={buttonClassName({ variant: 'primary' })} href="/tasks/new">
                  Create first Task
                </Link>
              ) : null
            }
            description={
              canWrite
                ? 'Create the first focused work item for this workspace.'
                : 'Tasks created by workspace contributors will appear here.'
            }
            icon="checkSquare"
            title="No active Tasks"
          />
        </Card>
      )}
    </div>
  );
}
