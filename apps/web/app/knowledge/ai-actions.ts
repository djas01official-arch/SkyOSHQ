'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  AiConversationError,
  AiConversationRateLimitError,
  AiConversationValidationError,
  runKnowledgeDocumentAiAction,
} from '../../../../database/ai/ai-conversations';
import { AiKnowledgeActionType } from '../../../../database/generated/client/client';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { aiConversationDependencies } from '@/lib/ai-conversations';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type KnowledgeAiActionState = Readonly<{ error: string | null }>;

function value(formData: FormData, name: string): string {
  const input = formData.get(name);
  return typeof input === 'string' ? input : '';
}

function version(formData: FormData): number | null {
  const input = value(formData, 'version');
  if (!/^\d+$/u.test(input)) return null;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function actionType(formData: FormData): AiKnowledgeActionType | null {
  const input = value(formData, 'actionType');
  return Object.values(AiKnowledgeActionType).includes(input as AiKnowledgeActionType)
    ? (input as AiKnowledgeActionType)
    : null;
}

export async function runKnowledgeAiAction(
  _state: KnowledgeAiActionState,
  formData: FormData,
): Promise<KnowledgeAiActionState> {
  const slug = value(formData, 'slug');
  const sourceVersion = version(formData);
  const selectedAction = actionType(formData);
  const view = value(formData, 'view');
  if (!slug || sourceVersion === null || selectedAction === null) {
    return { error: 'The selected Knowledge AI action is unavailable. Refresh and try again.' };
  }

  const [user, knowledgeContext, aiContext] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.read'),
    requireWorkspaceCapability('ai.use'),
  ]);
  const workspace = knowledgeContext.activeWorkspace;
  if (!workspace || aiContext.activeWorkspace?.id !== workspace.id) redirect('/knowledge');

  try {
    await runKnowledgeDocumentAiAction(
      prisma,
      aiConversationDependencies,
      user.id,
      workspace.id,
      slug,
      sourceVersion,
      selectedAction,
    );
  } catch (error) {
    if (
      error instanceof AiConversationValidationError ||
      error instanceof AiConversationRateLimitError
    ) {
      return { error: error.message };
    }
    if (error instanceof AiConversationError) {
      return { error: 'The AI action could not be completed for this Knowledge source.' };
    }
    throw error;
  }

  const sourcePath =
    view === 'version' ? `/knowledge/${slug}/history/${sourceVersion}` : `/knowledge/${slug}`;
  revalidatePath('/ai');
  revalidatePath(sourcePath);
  redirect(`${sourcePath}#ai-actions`);
}
