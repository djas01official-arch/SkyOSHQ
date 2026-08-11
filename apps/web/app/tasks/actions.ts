'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  TaskError,
  archiveTask,
  createTask,
  updateTask,
  type TaskInput,
} from '../../../../database/tasks/tasks';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type TaskActionState = Readonly<{ error: string | null }>;

function getString(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === 'string' ? value : null;
}

function getTaskInput(formData: FormData): TaskInput | null {
  const priority = getString(formData, 'priority');
  const status = getString(formData, 'status');
  const title = getString(formData, 'title');

  if (priority === null || status === null || title === null) return null;
  return {
    assigneeUserId: getString(formData, 'assigneeUserId'),
    description: getString(formData, 'description'),
    dueAt: getString(formData, 'dueAt'),
    priority,
    status,
    title,
  };
}

async function getWriteScope(): Promise<{ userId: string; workspaceId: string }> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('tasks.write'),
  ]);

  if (!context.activeWorkspace) redirect('/tasks');
  return { userId: user.id, workspaceId: context.activeWorkspace.id };
}

function getErrorState(error: unknown): TaskActionState {
  if (error instanceof TaskError) return { error: error.message };
  throw error;
}

export async function createTaskAction(
  _previousState: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const input = getTaskInput(formData);
  if (!input) return { error: 'The Task form is incomplete. Refresh and try again.' };
  const { userId, workspaceId } = await getWriteScope();
  let task: { id: string };

  try {
    task = await createTask(prisma, userId, workspaceId, input);
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/tasks');
  redirect(`/tasks/${task.id}`);
}

export async function updateTaskAction(
  _previousState: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const input = getTaskInput(formData);
  const taskId = getString(formData, 'taskId');
  if (!input || !taskId) {
    return { error: 'The Task form is incomplete. Refresh and try again.' };
  }
  const { userId, workspaceId } = await getWriteScope();

  try {
    await updateTask(prisma, userId, workspaceId, taskId, input);
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}`);
}

export async function archiveTaskAction(
  _previousState: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const taskId = getString(formData, 'taskId');
  if (!taskId) return { error: 'The Task is unavailable. Refresh and try again.' };
  const { userId, workspaceId } = await getWriteScope();

  try {
    await archiveTask(prisma, userId, workspaceId, taskId);
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  redirect('/tasks');
}
