import { createHash } from 'node:crypto';

import {
  DocumentProcessingJobStatus,
  KnowledgeAttachmentProcessingStatus,
  KnowledgeAttachmentStatus,
  KnowledgeDocumentStatus,
  OrganizationStatus,
  WorkspaceStatus,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import { findKnowledgeDocument, requireKnowledgeWorkspaceAccess } from './knowledge-documents';
import type { ObjectStorage } from '../../services/storage/object-storage';
import { StorageObjectNotFoundError } from '../../services/storage/object-storage';
import {
  UnsupportedDocumentParserError,
  type DocumentParserRegistry,
} from '../../services/document-processing/document-parser';
import type { DocumentProcessingQueue } from '../../services/document-processing/processing-queue';

export class DocumentProcessingError extends Error {}

export class DocumentProcessingConflictError extends DocumentProcessingError {}

export class DocumentProcessingNotFoundError extends DocumentProcessingError {}

export class DocumentProcessingStateError extends DocumentProcessingError {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

type Transaction = Prisma.TransactionClient;

export type DocumentProcessingRequestDependencies = Readonly<{
  parsers: DocumentParserRegistry;
  queue: DocumentProcessingQueue;
}>;

export type DocumentProcessingWorkerDependencies = Readonly<{
  parsers: DocumentParserRegistry;
  storage: ObjectStorage;
}>;

type ProcessingFailure = Readonly<{
  code: string;
  message: string;
}>;

async function findProcessableAttachment(
  prisma: PrismaClient | Transaction,
  workspaceId: string,
  documentId: string,
  attachmentId: string,
) {
  const attachment = await prisma.knowledgeAttachment.findFirst({
    where: {
      documentId,
      id: attachmentId,
      status: KnowledgeAttachmentStatus.ACTIVE,
      workspaceId,
    },
  });

  if (!attachment) {
    throw new DocumentProcessingNotFoundError(
      'The attachment was not found in this document and workspace.',
    );
  }

  return attachment;
}

function getFailure(error: unknown): ProcessingFailure {
  if (error instanceof StorageObjectNotFoundError) {
    return {
      code: 'binary_missing',
      message: 'The original attachment binary is unavailable.',
    };
  }
  if (error instanceof DocumentProcessingStateError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof UnsupportedDocumentParserError) {
    return {
      code: 'parser_version_unavailable',
      message: 'The parser version recorded for this job is unavailable.',
    };
  }
  return { code: 'extraction_failed', message: 'Text extraction failed.' };
}

export async function requestKnowledgeAttachmentProcessing(
  prisma: PrismaClient,
  dependencies: DocumentProcessingRequestDependencies,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, true);
  const document = await findKnowledgeDocument(prisma, workspaceId, documentSlug, false);
  const attachment = await findProcessableAttachment(
    prisma,
    workspaceId,
    document.id,
    attachmentId,
  );
  let parser;
  try {
    parser = dependencies.parsers.getCurrent(attachment.mimeType);
  } catch (error) {
    if (error instanceof UnsupportedDocumentParserError) {
      throw new DocumentProcessingStateError(
        'Only PDF and DOCX attachments can be processed.',
        'unsupported_attachment_type',
      );
    }
    throw error;
  }

  const job = await prisma.$transaction(async (transaction) => {
    const access = await requireKnowledgeWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      true,
    );
    const currentDocument = await findKnowledgeDocument(
      transaction,
      workspaceId,
      documentSlug,
      false,
    );
    const currentAttachment = await findProcessableAttachment(
      transaction,
      workspaceId,
      currentDocument.id,
      attachmentId,
    );

    if (currentAttachment.processingStatus === KnowledgeAttachmentProcessingStatus.PROCESSING) {
      throw new DocumentProcessingConflictError('This attachment is already being processed.');
    }

    const activeJob = await transaction.documentProcessingJob.findFirst({
      where: {
        attachmentId,
        status: {
          in: [DocumentProcessingJobStatus.QUEUED, DocumentProcessingJobStatus.PROCESSING],
        },
      },
      select: { id: true },
    });
    if (activeJob) {
      throw new DocumentProcessingConflictError('This attachment already has a pending job.');
    }

    const created = await transaction.documentProcessingJob.create({
      data: {
        attachmentId,
        parserName: parser.name,
        parserVersion: parser.version,
        requestedByUserId: actorUserId,
        workspaceId,
      },
    });

    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_REQUESTED,
      actorUserId,
      metadata: {
        jobId: created.id,
        parserName: created.parserName,
        parserVersion: created.parserVersion,
        previousProcessingStatus: currentAttachment.processingStatus,
      },
      organizationId: access.organizationId,
      targetId: attachmentId,
      targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
      workspaceId,
    });

    return created;
  });

  await dependencies.queue.enqueue(job.id);

  const persisted = await prisma.documentProcessingJob.findUnique({ where: { id: job.id } });
  if (!persisted) {
    throw new DocumentProcessingNotFoundError('The processing job could not be loaded.');
  }
  return persisted;
}

async function claimDocumentProcessingJob(prisma: PrismaClient, jobId: string) {
  return prisma.$transaction(async (transaction) => {
    const job = await transaction.documentProcessingJob.findUnique({
      where: { id: jobId },
      include: {
        attachment: {
          include: {
            document: true,
            workspace: {
              select: {
                organization: { select: { status: true } },
                organizationId: true,
                status: true,
              },
            },
          },
        },
      },
    });
    if (!job) {
      throw new DocumentProcessingNotFoundError('The processing job was not found.');
    }
    if (job.status !== DocumentProcessingJobStatus.QUEUED) {
      throw new DocumentProcessingConflictError('The processing job has already been claimed.');
    }
    const startedAt = new Date();
    await transaction.documentProcessingJob.update({
      where: { id: job.id },
      data: { startedAt, status: DocumentProcessingJobStatus.PROCESSING },
    });
    await transaction.knowledgeAttachment.update({
      where: { id: job.attachmentId },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.PROCESSING,
        updatedAt: startedAt,
      },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_STARTED,
      actorUserId: job.requestedByUserId,
      metadata: {
        jobId: job.id,
        parserName: job.parserName,
        parserVersion: job.parserVersion,
      },
      organizationId: job.attachment.workspace.organizationId,
      targetId: job.attachmentId,
      targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
      workspaceId: job.workspaceId,
    });

    return {
      attachment: job.attachment,
      job,
      organizationId: job.attachment.workspace.organizationId,
    };
  });
}

async function completeDocumentProcessingJob(
  prisma: PrismaClient,
  job: Awaited<ReturnType<typeof claimDocumentProcessingJob>>,
  extractedText: string,
): Promise<void> {
  const textSha256 = createHash('sha256').update(extractedText, 'utf8').digest('hex');

  await prisma.$transaction(async (transaction) => {
    const current = await transaction.documentProcessingJob.findUnique({
      where: { id: job.job.id },
    });
    if (!current || current.status !== DocumentProcessingJobStatus.PROCESSING) {
      throw new DocumentProcessingConflictError('The processing job is no longer active.');
    }

    const latest = await transaction.knowledgeAttachmentExtraction.aggregate({
      where: { attachmentId: job.job.attachmentId },
      _max: { extractionNumber: true },
    });
    const extraction = await transaction.knowledgeAttachmentExtraction.create({
      data: {
        attachmentId: job.job.attachmentId,
        extractedText,
        extractionNumber: (latest._max.extractionNumber ?? 0) + 1,
        jobId: job.job.id,
        parserName: job.job.parserName,
        parserVersion: job.job.parserVersion,
        textSha256,
        workspaceId: job.job.workspaceId,
      },
    });
    const completedAt = new Date();
    await transaction.knowledgeAttachment.update({
      where: { id: job.job.attachmentId },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.PROCESSED,
        updatedAt: completedAt,
      },
    });
    await transaction.documentProcessingJob.update({
      where: { id: job.job.id },
      data: { completedAt, status: DocumentProcessingJobStatus.SUCCEEDED },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_SUCCEEDED,
      actorUserId: job.job.requestedByUserId,
      metadata: {
        extractionId: extraction.id,
        extractionNumber: extraction.extractionNumber,
        jobId: job.job.id,
        parserName: extraction.parserName,
        parserVersion: extraction.parserVersion,
        textLength: extractedText.length,
        textSha256,
      },
      organizationId: job.organizationId,
      targetId: job.job.attachmentId,
      targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
      workspaceId: job.job.workspaceId,
    });
  });
}

async function failDocumentProcessingJob(
  prisma: PrismaClient,
  job: Awaited<ReturnType<typeof claimDocumentProcessingJob>>,
  failure: ProcessingFailure,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.documentProcessingJob.findUnique({
      where: { id: job.job.id },
    });
    if (!current || current.status !== DocumentProcessingJobStatus.PROCESSING) {
      throw new DocumentProcessingConflictError('The processing job is no longer active.');
    }

    const completedAt = new Date();
    await transaction.knowledgeAttachment.update({
      where: { id: job.job.attachmentId },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.FAILED,
        updatedAt: completedAt,
      },
    });
    await transaction.documentProcessingJob.update({
      where: { id: job.job.id },
      data: {
        completedAt,
        errorMessage: failure.message,
        status: DocumentProcessingJobStatus.FAILED,
      },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_FAILED,
      actorUserId: job.job.requestedByUserId,
      metadata: { errorCode: failure.code, jobId: job.job.id },
      organizationId: job.organizationId,
      targetId: job.job.attachmentId,
      targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
      workspaceId: job.job.workspaceId,
    });
  });
}

export async function executeDocumentProcessingJob(
  prisma: PrismaClient,
  dependencies: DocumentProcessingWorkerDependencies,
  jobId: string,
): Promise<void> {
  const claimed = await claimDocumentProcessingJob(prisma, jobId);

  try {
    if (
      claimed.attachment.status !== KnowledgeAttachmentStatus.ACTIVE ||
      claimed.attachment.document.status !== KnowledgeDocumentStatus.ACTIVE ||
      claimed.attachment.workspace.status !== WorkspaceStatus.ACTIVE ||
      claimed.attachment.workspace.organization.status !== OrganizationStatus.ACTIVE
    ) {
      throw new DocumentProcessingStateError(
        'Archived knowledge cannot be processed.',
        'knowledge_archived',
      );
    }

    const bytes = await dependencies.storage.getObject(claimed.attachment.storageKey);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (
      checksum !== claimed.attachment.sha256Checksum ||
      BigInt(bytes.byteLength) !== claimed.attachment.sizeBytes
    ) {
      throw new DocumentProcessingStateError(
        'The original attachment binary failed integrity verification.',
        'binary_integrity_failed',
      );
    }

    const parser = dependencies.parsers.getVersion(
      claimed.attachment.mimeType,
      claimed.job.parserName,
      claimed.job.parserVersion,
    );
    const extractedText = await parser.extractText(bytes);
    await completeDocumentProcessingJob(prisma, claimed, extractedText);
  } catch (error) {
    await failDocumentProcessingJob(prisma, claimed, getFailure(error));
  }
}

export async function listKnowledgeAttachmentExtractions(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  const document = await findKnowledgeDocument(prisma, workspaceId, documentSlug, true);
  await findProcessableAttachment(prisma, workspaceId, document.id, attachmentId);

  return prisma.knowledgeAttachmentExtraction.findMany({
    where: { attachmentId, workspaceId },
    orderBy: { extractionNumber: 'desc' },
  });
}
