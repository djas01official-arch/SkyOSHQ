'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  createAiConversation,
  retryAiRun,
  setAiConversationArchived,
  submitAiMessage,
} from '../../../../database/ai/ai-conversations';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { aiConversationDependencies } from '@/lib/ai-conversations';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

function value(formData: FormData, name: string): string {
  const input = formData.get(name);
  return typeof input === 'string' ? input : '';
}

export async function createConversationAction(): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  const conversation = await createAiConversation(prisma, user.id, context.activeWorkspace.id);
  redirect(`/ai/${conversation.id}`);
}

export async function submitMessageAction(formData: FormData): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  const conversationId = value(formData, 'conversationId');
  await submitAiMessage(
    prisma,
    aiConversationDependencies,
    user.id,
    context.activeWorkspace.id,
    conversationId,
    value(formData, 'message'),
  );
  revalidatePath('/ai');
  revalidatePath(`/ai/${conversationId}`);
  redirect(`/ai/${conversationId}`);
}

export async function retryRunAction(formData: FormData): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  const conversationId = value(formData, 'conversationId');
  await retryAiRun(
    prisma,
    aiConversationDependencies,
    user.id,
    context.activeWorkspace.id,
    value(formData, 'runId'),
  );
  revalidatePath(`/ai/${conversationId}`);
  redirect(`/ai/${conversationId}`);
}

export async function setConversationArchivedAction(formData: FormData): Promise<void> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('ai.use'),
  ]);
  if (!context.activeWorkspace) redirect('/dashboard');
  await setAiConversationArchived(
    prisma,
    user.id,
    context.activeWorkspace.id,
    value(formData, 'conversationId'),
    value(formData, 'archived') === 'true',
  );
  revalidatePath('/ai');
  redirect('/ai');
}
