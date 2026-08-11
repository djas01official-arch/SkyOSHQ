'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  TaskConflictError,
  TaskError,
  archiveTask,
  createTask,
  updateTask,
  type TaskInput,
} from '../../../../database/tasks/tasks';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type TaskActionState = Readonly<{
  conflict: boolean;
  error: string | null;
  values: TaskInput | null;
}>;

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

function getErrorState(error: unknown, values: TaskInput | null = null): TaskActionState {
  if (error instanceof TaskError) {
    return { conflict: error instanceof TaskConflictError, error: error.message, values };
  }
  throw error;
}

export async function createTaskAction(
  _previousState: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const input = getTaskInput(formData);
  if (!input) {
    return {
      conflict: false,
      error: 'The Task form is incomplete. Refresh and try again.',
      values: null,
    };
  }
  const { userId, workspaceId } = await getWriteScope();
  let task: { id: string };

  try {
    task = await createTask(prisma, userId, workspaceId, input);
  } catch (error) {
    return getErrorState(error, input);
  }

  revalidatePath('/tasks');
  redirect(`/tasks/${task.id}`);
}

export async function updateTaskAction(
  _previousState: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const input = getTaskInput(formData);
  const expectedUpdatedAt = getString(formData, 'expectedUpdatedAt');
  const taskId = getString(formData, 'taskId');
  const { userId, workspaceId } = await getWriteScope();
  if (!input || !taskId || !expectedUpdatedAt) {
    return {
      conflict: false,
      error: 'The Task form is incomplete. Refresh and try again.',
      values: null,
    };
  }

  try {
    await updateTask(prisma, userId, workspaceId, taskId, expectedUpdatedAt, input);
  } catch (error) {
    return getErrorState(error, input);
  }

  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}`);
}

export async function archiveTaskAction(
  _previousState: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const expectedUpdatedAt = getString(formData, 'expectedUpdatedAt');
  const taskId = getString(formData, 'taskId');
  const { userId, workspaceId } = await getWriteScope();
  if (!taskId || !expectedUpdatedAt) {
    return {
      conflict: false,
      error: 'The Task is unavailable. Refresh and try again.',
      values: null,
    };
  }

  try {
    await archiveTask(prisma, userId, workspaceId, taskId, expectedUpdatedAt);
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  redirect('/tasks');
}
