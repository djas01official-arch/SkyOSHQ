'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  KnowledgeDocumentError,
  archiveKnowledgeDocument,
  createKnowledgeDocument,
  restoreKnowledgeDocument,
  restoreKnowledgeDocumentVersion,
  updateKnowledgeDocument,
} from '../../../../database/knowledge/knowledge-documents';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type KnowledgeDocumentActionState = Readonly<{
  error: string | null;
}>;

function getString(formData: FormData, name: string): string | null {
  const value = formData.get(name);

  return typeof value === 'string' ? value : null;
}

function getVersion(formData: FormData): number | null {
  const value = getString(formData, 'version');

  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

async function getWriteScope(): Promise<{ userId: string; workspaceId: string }> {
  const [user, context] = await Promise.all([
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.write'),
  ]);

  if (!context.activeWorkspace) {
    redirect('/knowledge');
  }

  return { userId: user.id, workspaceId: context.activeWorkspace.id };
}

function getErrorState(error: unknown): KnowledgeDocumentActionState {
  if (error instanceof KnowledgeDocumentError) {
    return { error: error.message };
  }

  throw error;
}

export async function createKnowledgeDocumentAction(
  _previousState: KnowledgeDocumentActionState,
  formData: FormData,
): Promise<KnowledgeDocumentActionState> {
  const title = getString(formData, 'title');
  const content = getString(formData, 'content');

  if (title === null || content === null) {
    return { error: 'Enter a title and Markdown content.' };
  }

  const { userId, workspaceId } = await getWriteScope();
  let document: { slug: string };

  try {
    document = await createKnowledgeDocument(prisma, userId, workspaceId, { content, title });
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/knowledge');
  redirect(`/knowledge/${document.slug}`);
}

export async function updateKnowledgeDocumentAction(
  _previousState: KnowledgeDocumentActionState,
  formData: FormData,
): Promise<KnowledgeDocumentActionState> {
  const title = getString(formData, 'title');
  const content = getString(formData, 'content');
  const slug = getString(formData, 'slug');
  const version = getVersion(formData);

  if (title === null || content === null || !slug || version === null) {
    return { error: 'The document form is incomplete. Refresh and try again.' };
  }

  const { userId, workspaceId } = await getWriteScope();

  try {
    await updateKnowledgeDocument(prisma, userId, workspaceId, slug, version, { content, title });
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/knowledge');
  revalidatePath(`/knowledge/${slug}`);
  redirect(`/knowledge/${slug}`);
}

async function transitionKnowledgeDocumentAction(
  _previousState: KnowledgeDocumentActionState,
  formData: FormData,
  transition: 'archive' | 'restore',
): Promise<KnowledgeDocumentActionState> {
  const slug = getString(formData, 'slug');
  const version = getVersion(formData);

  if (!slug || version === null) {
    return { error: 'The document version is unavailable. Refresh and try again.' };
  }

  const { userId, workspaceId } = await getWriteScope();

  try {
    if (transition === 'archive') {
      await archiveKnowledgeDocument(prisma, userId, workspaceId, slug, version);
    } else {
      await restoreKnowledgeDocument(prisma, userId, workspaceId, slug, version);
    }
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/knowledge');
  revalidatePath(`/knowledge/${slug}`);
  redirect(transition === 'archive' ? '/knowledge' : `/knowledge/${slug}`);
}

export async function archiveKnowledgeDocumentAction(
  previousState: KnowledgeDocumentActionState,
  formData: FormData,
): Promise<KnowledgeDocumentActionState> {
  return transitionKnowledgeDocumentAction(previousState, formData, 'archive');
}

export async function restoreKnowledgeDocumentAction(
  previousState: KnowledgeDocumentActionState,
  formData: FormData,
): Promise<KnowledgeDocumentActionState> {
  return transitionKnowledgeDocumentAction(previousState, formData, 'restore');
}

export async function restoreKnowledgeDocumentVersionAction(
  _previousState: KnowledgeDocumentActionState,
  formData: FormData,
): Promise<KnowledgeDocumentActionState> {
  const slug = getString(formData, 'slug');
  const version = getVersion(formData);
  const sourceValue = getString(formData, 'sourceVersion');
  const sourceVersion = sourceValue && /^\d+$/.test(sourceValue) ? Number(sourceValue) : Number.NaN;

  if (!slug || version === null || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    return { error: 'The document version is unavailable. Refresh and try again.' };
  }

  const { userId, workspaceId } = await getWriteScope();

  try {
    await restoreKnowledgeDocumentVersion(
      prisma,
      userId,
      workspaceId,
      slug,
      sourceVersion,
      version,
    );
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath('/knowledge');
  revalidatePath(`/knowledge/${slug}`);
  revalidatePath(`/knowledge/${slug}/history`);
  redirect(`/knowledge/${slug}`);
}
