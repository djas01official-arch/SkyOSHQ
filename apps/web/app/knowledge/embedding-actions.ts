'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  KnowledgeEmbeddingError,
  requestKnowledgeChunkSetEmbedding,
} from '../../../../database/knowledge/knowledge-embeddings';
import { EmbeddingProviderError } from '../../../../services/embeddings/embedding-provider';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { knowledgeEmbeddingRequestDependencies } from '@/lib/knowledge-embeddings';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type KnowledgeEmbeddingActionState = Readonly<{ error: string | null }>;

function value(formData: FormData, name: string): string | null {
  const input = formData.get(name);
  return typeof input === 'string' && input.length > 0 ? input : null;
}

export async function embedKnowledgeChunkSetAction(
  _state: KnowledgeEmbeddingActionState,
  formData: FormData,
): Promise<KnowledgeEmbeddingActionState> {
  const chunkSetId = value(formData, 'chunkSetId');
  const slug = value(formData, 'slug');
  if (!chunkSetId || !slug) {
    return { error: 'The chunk set is unavailable. Refresh and try again.' };
  }
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.write'),
  ]);
  if (!context.activeWorkspace) redirect('/knowledge');
  try {
    await requestKnowledgeChunkSetEmbedding(
      prisma,
      knowledgeEmbeddingRequestDependencies,
      user.id,
      context.activeWorkspace.id,
      chunkSetId,
    );
  } catch (error) {
    if (error instanceof KnowledgeEmbeddingError || error instanceof EmbeddingProviderError) {
      return { error: error.message };
    }
    throw error;
  }
  revalidatePath(`/knowledge/${slug}`);
  return { error: null };
}
