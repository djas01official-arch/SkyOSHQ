'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  KnowledgeChunkingError,
  requestKnowledgeAttachmentChunking,
  requestKnowledgeDocumentChunking,
} from '../../../../database/knowledge/knowledge-chunking';
import { KnowledgeDocumentError } from '../../../../database/knowledge/knowledge-documents';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { knowledgeChunkingRequestDependencies } from '@/lib/knowledge-chunking';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type KnowledgeChunkingActionState = Readonly<{ error: string | null }>;

function value(formData: FormData, name: string): string | null {
  const input = formData.get(name);
  return typeof input === 'string' && input.length > 0 ? input : null;
}

async function writeScope() {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.write'),
  ]);
  if (!context.activeWorkspace) redirect('/knowledge');
  return { userId: user.id, workspaceId: context.activeWorkspace.id };
}

function errorState(error: unknown): KnowledgeChunkingActionState {
  if (error instanceof KnowledgeChunkingError || error instanceof KnowledgeDocumentError) {
    return { error: error.message };
  }
  throw error;
}

export async function chunkKnowledgeDocumentAction(
  _state: KnowledgeChunkingActionState,
  formData: FormData,
): Promise<KnowledgeChunkingActionState> {
  const slug = value(formData, 'slug');
  if (!slug) return { error: 'The document is unavailable. Refresh and try again.' };
  const scope = await writeScope();
  try {
    await requestKnowledgeDocumentChunking(
      prisma,
      knowledgeChunkingRequestDependencies,
      scope.userId,
      scope.workspaceId,
      slug,
    );
  } catch (error) {
    return errorState(error);
  }
  revalidatePath(`/knowledge/${slug}`);
  return { error: null };
}

export async function chunkKnowledgeAttachmentAction(
  _state: KnowledgeChunkingActionState,
  formData: FormData,
): Promise<KnowledgeChunkingActionState> {
  const slug = value(formData, 'slug');
  const attachmentId = value(formData, 'attachmentId');
  if (!slug || !attachmentId) {
    return { error: 'The attachment is unavailable. Refresh and try again.' };
  }
  const scope = await writeScope();
  try {
    await requestKnowledgeAttachmentChunking(
      prisma,
      knowledgeChunkingRequestDependencies,
      scope.userId,
      scope.workspaceId,
      slug,
      attachmentId,
    );
  } catch (error) {
    return errorState(error);
  }
  revalidatePath(`/knowledge/${slug}`);
  return { error: null };
}
