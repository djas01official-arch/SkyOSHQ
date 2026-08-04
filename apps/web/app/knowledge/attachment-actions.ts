'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  KnowledgeAttachmentError,
  archiveKnowledgeAttachment,
  restoreKnowledgeAttachment,
  uploadKnowledgeAttachment,
} from '../../../../database/knowledge/knowledge-attachments';
import { KnowledgeDocumentError } from '../../../../database/knowledge/knowledge-documents';
import {
  DocumentProcessingError,
  requestKnowledgeAttachmentProcessing,
} from '../../../../database/knowledge/document-processing';

import { requireCurrentUser } from '@/lib/auth/current-user';
import { knowledgeAttachmentDependencies } from '@/lib/knowledge-storage';
import { documentProcessingRequestDependencies } from '@/lib/document-processing';
import { requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

export type KnowledgeAttachmentActionState = Readonly<{
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

function getErrorState(error: unknown): KnowledgeAttachmentActionState {
  if (
    error instanceof DocumentProcessingError ||
    error instanceof KnowledgeAttachmentError ||
    error instanceof KnowledgeDocumentError
  ) {
    return { error: error.message };
  }

  throw error;
}

export async function processKnowledgeAttachmentAction(
  _previousState: KnowledgeAttachmentActionState,
  formData: FormData,
): Promise<KnowledgeAttachmentActionState> {
  const attachmentId = getString(formData, 'attachmentId');
  const slug = getString(formData, 'slug');

  if (!attachmentId || !slug) {
    return { error: 'The attachment is unavailable. Refresh and try again.' };
  }

  const { userId, workspaceId } = await getWriteScope();

  try {
    await requestKnowledgeAttachmentProcessing(
      prisma,
      documentProcessingRequestDependencies,
      userId,
      workspaceId,
      slug,
      attachmentId,
    );
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath(`/knowledge/${slug}`);
  return { error: null };
}

export async function uploadKnowledgeAttachmentAction(
  _previousState: KnowledgeAttachmentActionState,
  formData: FormData,
): Promise<KnowledgeAttachmentActionState> {
  const file = formData.get('file');
  const slug = getString(formData, 'slug');

  if (!(file instanceof File) || !slug) {
    return { error: 'Choose a supported attachment and try again.' };
  }
  if (file.size > knowledgeAttachmentDependencies.maxFileSizeBytes) {
    return {
      error: `The attachment exceeds the configured ${knowledgeAttachmentDependencies.maxFileSizeBytes}-byte limit.`,
    };
  }

  const { userId, workspaceId } = await getWriteScope();

  try {
    await uploadKnowledgeAttachment(
      prisma,
      knowledgeAttachmentDependencies,
      userId,
      workspaceId,
      slug,
      {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type,
        originalFilename: file.name,
      },
    );
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath(`/knowledge/${slug}`);
  return { error: null };
}

async function transitionAttachmentAction(
  formData: FormData,
  transition: 'archive' | 'restore',
): Promise<KnowledgeAttachmentActionState> {
  const attachmentId = getString(formData, 'attachmentId');
  const slug = getString(formData, 'slug');
  const version = getVersion(formData);

  if (!attachmentId || !slug || version === null) {
    return { error: 'The attachment version is unavailable. Refresh and try again.' };
  }

  const { userId, workspaceId } = await getWriteScope();

  try {
    if (transition === 'archive') {
      await archiveKnowledgeAttachment(prisma, userId, workspaceId, slug, attachmentId, version);
    } else {
      await restoreKnowledgeAttachment(prisma, userId, workspaceId, slug, attachmentId, version);
    }
  } catch (error) {
    return getErrorState(error);
  }

  revalidatePath(`/knowledge/${slug}`);
  return { error: null };
}

export async function archiveKnowledgeAttachmentAction(
  _previousState: KnowledgeAttachmentActionState,
  formData: FormData,
): Promise<KnowledgeAttachmentActionState> {
  return transitionAttachmentAction(formData, 'archive');
}

export async function restoreKnowledgeAttachmentAction(
  _previousState: KnowledgeAttachmentActionState,
  formData: FormData,
): Promise<KnowledgeAttachmentActionState> {
  return transitionAttachmentAction(formData, 'restore');
}
