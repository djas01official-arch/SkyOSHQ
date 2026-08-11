import Link from 'next/link';

import { listTaskAssignees } from '../../../../../database/tasks/tasks';

import { createTaskAction } from '@/app/tasks/actions';
import { TaskForm } from '@/components/tasks/task-form';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export default async function NewTaskPage() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('tasks.write'),
  ]);
  const workspace = context.activeWorkspace;
  if (!workspace) return null;
  const assignees = await listTaskAssignees(prisma, user.id, workspace.id);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        description={`Create a focused work item for ${workspace.name}.`}
        eyebrow="Tasks"
        title="New Task"
      />
      <Card>
        <TaskForm
          action={createTaskAction}
          assignees={assignees}
          kind="create"
          submitLabel="Create Task"
        />
      </Card>
      <Link
        className="mt-5 inline-block text-sm font-medium text-accent hover:underline"
        href="/tasks"
      >
        Back to Tasks
      </Link>
    </div>
  );
}
