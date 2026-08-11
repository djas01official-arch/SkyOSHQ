import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  TaskNotFoundError,
  getTask,
  isTaskAssigneeEffective,
  listTaskAssignees,
  serializeTaskConcurrencyToken,
} from '../../../../../../database/tasks/tasks';

import { updateTaskAction } from '@/app/tasks/actions';
import { TaskForm } from '@/components/tasks/task-form';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type EditTaskPageProps = Readonly<{ params: Promise<{ taskId: string }> }>;

export default async function EditTaskPage({ params }: EditTaskPageProps) {
  const [{ taskId }, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('tasks.write'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) notFound();

  let task;
  let assignees;
  try {
    [task, assignees] = await Promise.all([
      getTask(prisma, user.id, workspace.id, taskId),
      listTaskAssignees(prisma, user.id, workspace.id),
    ]);
  } catch (error) {
    if (error instanceof TaskNotFoundError) notFound();
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        description="Update the Task within the currently selected workspace."
        eyebrow="Tasks"
        title="Edit Task"
      />
      <Card>
        <TaskForm
          action={updateTaskAction}
          assigneeUserId={
            task.assigneeUserId && isTaskAssigneeEffective(task) ? task.assigneeUserId : ''
          }
          assignees={assignees}
          description={task.description ?? ''}
          dueAt={task.dueAt?.toISOString().slice(0, 10) ?? ''}
          expectedUpdatedAt={serializeTaskConcurrencyToken(task.updatedAt)}
          kind="edit"
          priority={task.priority}
          status={task.status}
          submitLabel="Save Task"
          taskId={task.id}
          title={task.title}
        />
      </Card>
      <Link
        className="mt-5 inline-block text-sm font-medium text-accent hover:underline"
        href={`/tasks/${task.id}`}
      >
        Cancel
      </Link>
    </div>
  );
}
