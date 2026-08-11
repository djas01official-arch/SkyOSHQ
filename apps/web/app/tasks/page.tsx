import Link from 'next/link';

import {
  TaskValidationError,
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

type TasksPageProps = Readonly<{
  searchParams: Promise<{ cursor?: string | string[] }>;
}>;

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const [user, context, resolvedSearchParams] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('tasks.read'),
    searchParams,
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;

  let taskPage: Awaited<ReturnType<typeof listTasks>> | null = null;
  let paginationError = false;
  try {
    if (
      resolvedSearchParams.cursor !== undefined &&
      typeof resolvedSearchParams.cursor !== 'string'
    ) {
      throw new TaskValidationError('The Task cursor is invalid.');
    }
    taskPage = await listTasks(prisma, user.id, workspace.id, {
      cursor: resolvedSearchParams.cursor,
    });
  } catch (error) {
    if (!(error instanceof TaskValidationError)) throw error;
    paginationError = true;
  }

  const tasks = taskPage?.items ?? [];
  const canWrite = hasWorkspaceCapability(workspace.role, 'tasks.write');
  const incompleteCount = tasks.filter(({ status }) => status !== TaskStatus.DONE).length;
  const isContinuation = typeof resolvedSearchParams.cursor === 'string';
  const nextPageHref = taskPage?.nextCursor
    ? `/tasks?cursor=${encodeURIComponent(taskPage.nextCursor)}`
    : null;

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

      {paginationError ? (
        <Card className="grid min-h-72 place-items-center">
          <EmptyState
            action={
              <Link
                className={buttonClassName({ variant: 'secondary' })}
                data-task-pagination="reset"
                href="/tasks"
              >
                Return to first page
              </Link>
            }
            description="This page link is invalid or belongs to another workspace. Start again from the first page."
            icon="checkSquare"
            title="Tasks page unavailable"
          />
        </Card>
      ) : tasks.length ? (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {incompleteCount} incomplete · {tasks.length} active on this page
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
          {nextPageHref ? (
            <div className="mt-6 flex justify-end border-t border-border pt-5">
              <Link
                className={buttonClassName({ variant: 'secondary' })}
                data-task-pagination="next"
                href={nextPageHref}
              >
                Next page
              </Link>
            </div>
          ) : null}
        </>
      ) : isContinuation ? (
        <Card className="grid min-h-72 place-items-center">
          <EmptyState
            action={
              <Link
                className={buttonClassName({ variant: 'secondary' })}
                data-task-pagination="reset"
                href="/tasks"
              >
                Return to first page
              </Link>
            }
            description="Tasks may have changed since this page link was created. Start again from the first page."
            icon="checkSquare"
            title="No Tasks on this page"
          />
        </Card>
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
