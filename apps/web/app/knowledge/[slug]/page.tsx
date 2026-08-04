import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  KnowledgeNotFoundError,
  getKnowledgeDocument,
} from '../../../../../database/knowledge/knowledge-documents';
import { listKnowledgeAttachments } from '../../../../../database/knowledge/knowledge-attachments';
import { getKnowledgeChunkingOverview } from '../../../../../database/knowledge/knowledge-chunking';
import {
  KnowledgeAttachmentProcessingStatus,
  KnowledgeAttachmentStatus,
  KnowledgeDocumentStatus,
} from '../../../../../database/generated/client/client';

import {
  archiveKnowledgeDocumentAction,
  restoreKnowledgeDocumentAction,
} from '@/app/knowledge/actions';
import {
  archiveKnowledgeAttachmentAction,
  processKnowledgeAttachmentAction,
  restoreKnowledgeAttachmentAction,
  uploadKnowledgeAttachmentAction,
} from '@/app/knowledge/attachment-actions';
import {
  chunkKnowledgeAttachmentAction,
  chunkKnowledgeDocumentAction,
} from '@/app/knowledge/chunking-actions';
import { KnowledgeAttachmentLifecycle } from '@/components/knowledge/knowledge-attachment-lifecycle';
import { KnowledgeAttachmentProcessing } from '@/components/knowledge/knowledge-attachment-processing';
import { KnowledgeAttachmentUpload } from '@/components/knowledge/knowledge-attachment-upload';
import { KnowledgeChunkingControl } from '@/components/knowledge/knowledge-chunking-control';
import { KnowledgeDocumentLifecycle } from '@/components/knowledge/knowledge-document-lifecycle';
import { MarkdownDocument } from '@/components/knowledge/markdown-document';
import { Card } from '@/components/ui/card';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { knowledgeAttachmentDependencies } from '@/lib/knowledge-storage';
import { hasWorkspaceCapability, requireWorkspaceCapability } from '@/lib/organization-context';
import { prisma } from '@/lib/prisma';

type KnowledgeDocumentPageProps = Readonly<{
  params: Promise<{ slug: string }>;
}>;

function formatFileSize(size: bigint): string {
  const bytes = Number(size);
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatProcessingStatus(status: KnowledgeAttachmentProcessingStatus): string {
  switch (status) {
    case KnowledgeAttachmentProcessingStatus.UPLOADED:
      return 'Uploaded';
    case KnowledgeAttachmentProcessingStatus.PROCESSING:
      return 'Processing';
    case KnowledgeAttachmentProcessingStatus.PROCESSED:
      return 'Processed';
    case KnowledgeAttachmentProcessingStatus.FAILED:
      return 'Failed';
  }
}

function isProcessableAttachment(mimeType: string): boolean {
  return (
    mimeType === 'application/pdf' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

type ChunkingSummary = Readonly<{
  chunkSet: { chunkCount: number } | null;
  errorMessage: string | null;
  sourceVersion: number;
  status: string;
}>;

function describeChunking(
  summary: ChunkingSummary | null | undefined,
  sourceLabel: string,
): string {
  if (!summary) return `Not processed for the current ${sourceLabel}.`;
  if (summary.status === 'QUEUED') return 'Queued.';
  if (summary.status === 'PROCESSING') return 'Processing.';
  if (summary.status === 'FAILED') return `Failed · ${summary.errorMessage ?? 'Chunking failed.'}`;
  return summary.chunkSet
    ? `${summary.chunkSet.chunkCount} chunks · ${sourceLabel} ${summary.sourceVersion}`
    : 'Processing result unavailable.';
}

export default async function KnowledgeDocumentPage({ params }: KnowledgeDocumentPageProps) {
  const [{ slug }, user, context] = await Promise.all([
    params,
    requireCurrentUser(),
    requireWorkspaceCapability('knowledge.read'),
  ]);
  const workspace = context.activeWorkspace;

  if (!workspace) {
    notFound();
  }

  const canWrite = hasWorkspaceCapability(workspace.role, 'knowledge.write');
  let document;
  let attachments;
  let chunking;
  try {
    [document, attachments, chunking] = await Promise.all([
      getKnowledgeDocument(prisma, user.id, workspace.id, slug, true),
      listKnowledgeAttachments(prisma, user.id, workspace.id, slug, canWrite),
      getKnowledgeChunkingOverview(prisma, user.id, workspace.id, slug),
    ]);
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) {
      notFound();
    }
    throw error;
  }

  const isArchived = document.status === KnowledgeDocumentStatus.ARCHIVED;
  const author = document.author.displayName ?? document.author.email ?? 'Unknown author';
  const activeAttachments = attachments.filter(
    (attachment) => attachment.status === KnowledgeAttachmentStatus.ACTIVE,
  );
  const archivedAttachments = attachments.filter(
    (attachment) => attachment.status === KnowledgeAttachmentStatus.ARCHIVED,
  );

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col justify-between gap-5 border-b border-border pb-7 sm:flex-row sm:items-start">
        <div>
          <Link className="text-sm font-medium text-accent hover:underline" href="/knowledge">
            Knowledge
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {document.title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {author} · Version {document.version} · Updated {document.updatedAt.toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex h-8 items-center rounded-control border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-raised"
            href={`/knowledge/${document.slug}/history`}
          >
            Version history
          </Link>
          {canWrite ? (
            <>
              {!isArchived ? (
                <Link
                  className="inline-flex h-8 items-center rounded-control border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-raised"
                  href={`/knowledge/${document.slug}/edit`}
                >
                  Edit
                </Link>
              ) : null}
              <KnowledgeDocumentLifecycle
                action={
                  isArchived ? restoreKnowledgeDocumentAction : archiveKnowledgeDocumentAction
                }
                label={isArchived ? 'Restore' : 'Archive'}
                slug={document.slug}
                version={document.version}
              />
            </>
          ) : null}
        </div>
      </div>

      {isArchived ? (
        <p className="mt-6 rounded-control bg-accent-soft px-3 py-2 text-sm text-accent">
          This document is archived and excluded from the normal knowledge list.
        </p>
      ) : null}
      <Card className="mt-6">
        <div className="mb-5 flex flex-col justify-between gap-3 border-b border-border pb-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Markdown chunks</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {describeChunking(chunking.document, 'version')}
            </p>
          </div>
          {canWrite && !isArchived ? (
            <KnowledgeChunkingControl
              action={chunkKnowledgeDocumentAction}
              label={chunking.document?.chunkSet ? 'Reprocess chunks' : 'Process chunks'}
              slug={document.slug}
            />
          ) : null}
        </div>
        <MarkdownDocument content={document.content} />
      </Card>

      <Card className="mt-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Attachments</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Workspace-protected source files. Downloads are always served as attachments.
          </p>
        </div>

        {canWrite && !isArchived ? (
          <KnowledgeAttachmentUpload
            action={uploadKnowledgeAttachmentAction}
            maxFileSizeBytes={knowledgeAttachmentDependencies.maxFileSizeBytes}
            slug={document.slug}
          />
        ) : null}

        <div className="mt-6 space-y-3">
          {activeAttachments.length ? (
            activeAttachments.map((attachment) => {
              const uploader =
                attachment.uploader.displayName ?? attachment.uploader.email ?? 'Unknown uploader';
              const latestExtraction = attachment.extractions[0];
              const latestJob = attachment.processingJobs[0];
              const isProcessable = isProcessableAttachment(attachment.mimeType);
              const attachmentChunking = chunking.attachments[attachment.id];

              return (
                <div
                  className="flex flex-col justify-between gap-3 rounded-control border border-border p-3 sm:flex-row sm:items-center"
                  key={attachment.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {attachment.originalFilename}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatFileSize(attachment.sizeBytes)} · {uploader} · Version{' '}
                      {attachment.version}
                    </p>
                    {latestExtraction ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Chunks: {describeChunking(attachmentChunking, 'extraction')}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {formatProcessingStatus(attachment.processingStatus)}
                      </span>
                      {latestExtraction
                        ? ` · Extraction ${latestExtraction.extractionNumber} · ${latestExtraction.parserName} ${latestExtraction.parserVersion}`
                        : !isProcessable
                          ? ' · Text extraction is available for PDF and DOCX only.'
                          : latestJob?.errorMessage
                            ? ` · ${latestJob.errorMessage}`
                            : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      className="text-sm font-medium text-accent hover:underline"
                      href={`/knowledge/${document.slug}/attachments/${attachment.id}/download`}
                    >
                      Download
                    </a>
                    {canWrite &&
                    !isArchived &&
                    isProcessable &&
                    attachment.processingStatus !==
                      KnowledgeAttachmentProcessingStatus.PROCESSING ? (
                      <KnowledgeAttachmentProcessing
                        action={processKnowledgeAttachmentAction}
                        attachmentId={attachment.id}
                        label={
                          attachment.processingStatus ===
                          KnowledgeAttachmentProcessingStatus.PROCESSED
                            ? 'Reprocess'
                            : 'Process'
                        }
                        slug={document.slug}
                      />
                    ) : null}
                    {canWrite && !isArchived && latestExtraction ? (
                      <KnowledgeChunkingControl
                        action={chunkKnowledgeAttachmentAction}
                        attachmentId={attachment.id}
                        label={attachmentChunking?.chunkSet ? 'Reprocess chunks' : 'Process chunks'}
                        slug={document.slug}
                      />
                    ) : null}
                    {canWrite && !isArchived ? (
                      <KnowledgeAttachmentLifecycle
                        action={archiveKnowledgeAttachmentAction}
                        attachmentId={attachment.id}
                        label="Archive"
                        slug={document.slug}
                        version={attachment.version}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">No active attachments.</p>
          )}
        </div>

        {canWrite && archivedAttachments.length ? (
          <div className="mt-7 border-t border-border pt-5">
            <h3 className="text-sm font-semibold text-foreground">Archived attachments</h3>
            <div className="mt-3 space-y-3">
              {archivedAttachments.map((attachment) => (
                <div
                  className="flex flex-col justify-between gap-3 rounded-control border border-border p-3 sm:flex-row sm:items-center"
                  key={attachment.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-muted-foreground">
                      {attachment.originalFilename}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatFileSize(attachment.sizeBytes)} · Version {attachment.version}
                    </p>
                  </div>
                  {!isArchived ? (
                    <KnowledgeAttachmentLifecycle
                      action={restoreKnowledgeAttachmentAction}
                      attachmentId={attachment.id}
                      label="Restore"
                      slug={document.slug}
                      version={attachment.version}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
