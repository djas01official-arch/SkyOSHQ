import {
  BackgroundJobKind,
  KnowledgeAttachmentStatus,
  KnowledgeChunkSourceType,
  KnowledgeChunkingJobStatus,
  KnowledgeDocumentStatus,
  OrganizationStatus,
  WorkspaceStatus,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import { findKnowledgeDocument, requireKnowledgeWorkspaceAccess } from './knowledge-documents';
import type { BackgroundJobQueue } from '../../services/document-processing/processing-queue';
import {
  EmptyChunkSourceError,
  UnknownChunkingStrategyError,
  type KnowledgeChunkingStrategyRegistry,
} from '../../services/knowledge-chunking/chunking-strategy';
import { createDurableBackgroundJob } from '../background-jobs/runtime';

export class KnowledgeChunkingError extends Error {}
export class KnowledgeChunkingConflictError extends KnowledgeChunkingError {}
export class KnowledgeChunkingNotFoundError extends KnowledgeChunkingError {}
export class KnowledgeChunkingStateError extends KnowledgeChunkingError {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

type Transaction = Prisma.TransactionClient;

export type KnowledgeChunkingRequestDependencies = Readonly<{
  queue: BackgroundJobQueue;
  strategies: KnowledgeChunkingStrategyRegistry;
}>;

export type KnowledgeChunkingWorkerDependencies = Readonly<{
  strategies: KnowledgeChunkingStrategyRegistry;
}>;

type ChunkSource = Readonly<{
  sourceType: KnowledgeChunkSourceType;
  sourceId: string;
  sourceVersion: number;
  documentVersionId?: string;
  attachmentExtractionId?: string;
}>;

type ClaimedJob = Awaited<ReturnType<typeof claimKnowledgeChunkingJob>>;

function failureFrom(error: unknown): { code: string; message: string } {
  if (error instanceof EmptyChunkSourceError) {
    return { code: 'empty_source', message: error.message };
  }
  if (error instanceof KnowledgeChunkingStateError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof UnknownChunkingStrategyError) {
    return {
      code: 'strategy_version_unavailable',
      message: 'The chunking strategy version recorded for this job is unavailable.',
    };
  }
  return { code: 'chunking_failed', message: 'Knowledge chunking failed.' };
}

async function createChunkingJob(
  transaction: Transaction,
  actorUserId: string,
  workspaceId: string,
  organizationId: string,
  source: ChunkSource,
  strategy: { key: string; version: string },
) {
  const activeJob = await transaction.knowledgeChunkingJob.findFirst({
    where: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourceVersion: source.sourceVersion,
      status: { in: [KnowledgeChunkingJobStatus.QUEUED, KnowledgeChunkingJobStatus.PROCESSING] },
      workspaceId,
    },
    select: { id: true },
  });
  if (activeJob) {
    throw new KnowledgeChunkingConflictError(
      'This source version already has a pending chunking job.',
    );
  }

  const job = await transaction.knowledgeChunkingJob.create({
    data: {
      attachmentExtractionId: source.attachmentExtractionId,
      documentVersionId: source.documentVersionId,
      requestedByUserId: actorUserId,
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourceVersion: source.sourceVersion,
      strategyKey: strategy.key,
      strategyVersion: strategy.version,
      workspaceId,
    },
  });
  await appendAuditEvent(transaction, {
    action: AuditAction.KNOWLEDGE_CHUNKING_REQUESTED,
    actorUserId,
    metadata: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourceVersion: source.sourceVersion,
      strategyKey: strategy.key,
      strategyVersion: strategy.version,
    },
    organizationId,
    targetId: job.id,
    targetType: AuditTargetType.KNOWLEDGE_CHUNKING_JOB,
    workspaceId,
  });
  await createDurableBackgroundJob(transaction, {
    domainJobId: job.id,
    idempotencyKey: `knowledge-chunking:${job.id}`,
    kind: BackgroundJobKind.KNOWLEDGE_CHUNKING,
    payload: {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourceVersion: source.sourceVersion,
    },
    requestedByUserId: actorUserId,
    workspaceId,
  });
  return job;
}

async function enqueueAndReload(prisma: PrismaClient, queue: BackgroundJobQueue, jobId: string) {
  await queue.enqueue(jobId);
  const persisted = await prisma.knowledgeChunkingJob.findUnique({ where: { id: jobId } });
  if (!persisted) {
    throw new KnowledgeChunkingNotFoundError('The chunking job could not be loaded.');
  }
  return persisted;
}

export async function requestKnowledgeDocumentChunking(
  prisma: PrismaClient,
  dependencies: KnowledgeChunkingRequestDependencies,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
) {
  const strategy = dependencies.strategies.getCurrent();
  const job = await prisma.$transaction(async (transaction) => {
    const access = await requireKnowledgeWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      true,
    );
    const document = await findKnowledgeDocument(transaction, workspaceId, documentSlug, false);
    const version = await transaction.knowledgeDocumentVersion.findUnique({
      where: {
        documentId_versionNumber: { documentId: document.id, versionNumber: document.version },
      },
    });
    if (!version) {
      throw new KnowledgeChunkingStateError(
        'The current document version is unavailable.',
        'source_version_missing',
      );
    }
    return createChunkingJob(
      transaction,
      actorUserId,
      workspaceId,
      access.organizationId,
      {
        documentVersionId: version.id,
        sourceId: document.id,
        sourceType: KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
        sourceVersion: version.versionNumber,
      },
      strategy,
    );
  });
  return enqueueAndReload(prisma, dependencies.queue, job.id);
}

export async function requestKnowledgeAttachmentChunking(
  prisma: PrismaClient,
  dependencies: KnowledgeChunkingRequestDependencies,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
  attachmentId: string,
) {
  const strategy = dependencies.strategies.getCurrent();
  const job = await prisma.$transaction(async (transaction) => {
    const access = await requireKnowledgeWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      true,
    );
    const document = await findKnowledgeDocument(transaction, workspaceId, documentSlug, false);
    const attachment = await transaction.knowledgeAttachment.findFirst({
      where: {
        documentId: document.id,
        id: attachmentId,
        status: KnowledgeAttachmentStatus.ACTIVE,
        workspaceId,
      },
    });
    if (!attachment) {
      throw new KnowledgeChunkingNotFoundError(
        'The attachment was not found in this active document and workspace.',
      );
    }
    const extraction = await transaction.knowledgeAttachmentExtraction.findFirst({
      where: { attachmentId, workspaceId },
      orderBy: { extractionNumber: 'desc' },
    });
    if (!extraction) {
      throw new KnowledgeChunkingStateError(
        'Process this PDF or DOCX attachment before creating chunks.',
        'extraction_missing',
      );
    }
    return createChunkingJob(
      transaction,
      actorUserId,
      workspaceId,
      access.organizationId,
      {
        attachmentExtractionId: extraction.id,
        sourceId: attachment.id,
        sourceType: KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
        sourceVersion: extraction.extractionNumber,
      },
      strategy,
    );
  });
  return enqueueAndReload(prisma, dependencies.queue, job.id);
}

async function claimKnowledgeChunkingJob(prisma: PrismaClient, jobId: string) {
  return prisma.$transaction(async (transaction) => {
    const job = await transaction.knowledgeChunkingJob.findUnique({
      where: { id: jobId },
      include: {
        attachmentExtraction: {
          include: {
            attachment: { include: { document: true } },
          },
        },
        documentVersion: { include: { document: true } },
        workspace: { include: { organization: true } },
      },
    });
    if (!job) {
      throw new KnowledgeChunkingNotFoundError('The chunking job was not found.');
    }
    if (job.status !== KnowledgeChunkingJobStatus.QUEUED) {
      throw new KnowledgeChunkingConflictError('The chunking job has already been claimed.');
    }

    const startedAt = new Date();
    await transaction.knowledgeChunkingJob.update({
      where: { id: job.id },
      data: { startedAt, status: KnowledgeChunkingJobStatus.PROCESSING },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_CHUNKING_STARTED,
      actorUserId: job.requestedByUserId,
      metadata: {
        sourceId: job.sourceId,
        sourceType: job.sourceType,
        sourceVersion: job.sourceVersion,
        strategyKey: job.strategyKey,
        strategyVersion: job.strategyVersion,
      },
      organizationId: job.workspace.organizationId,
      targetId: job.id,
      targetType: AuditTargetType.KNOWLEDGE_CHUNKING_JOB,
      workspaceId: job.workspaceId,
    });
    return job;
  });
}

function getClaimedSource(job: ClaimedJob): {
  documentStatus: KnowledgeDocumentStatus;
  text: string;
} {
  if (job.sourceType === KnowledgeChunkSourceType.MARKDOWN_DOCUMENT && job.documentVersion) {
    return {
      documentStatus: job.documentVersion.document.status,
      text: job.documentVersion.markdownContent,
    };
  }
  if (
    job.sourceType === KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION &&
    job.attachmentExtraction
  ) {
    if (job.attachmentExtraction.attachment.status !== KnowledgeAttachmentStatus.ACTIVE) {
      throw new KnowledgeChunkingStateError(
        'Archived knowledge cannot be chunked.',
        'knowledge_archived',
      );
    }
    return {
      documentStatus: job.attachmentExtraction.attachment.document.status,
      text: job.attachmentExtraction.extractedText,
    };
  }
  throw new KnowledgeChunkingStateError(
    'The chunking job source is unavailable.',
    'source_version_missing',
  );
}

async function completeKnowledgeChunkingJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  chunks: ReturnType<ReturnType<KnowledgeChunkingStrategyRegistry['getCurrent']>['chunk']>,
) {
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.knowledgeChunkingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status !== KnowledgeChunkingJobStatus.PROCESSING) {
      throw new KnowledgeChunkingConflictError('The chunking job is no longer active.');
    }
    const chunkSet = await transaction.knowledgeChunkSet.create({
      data: {
        attachmentExtractionId: job.attachmentExtractionId,
        chunkCount: chunks.length,
        createdByJobId: job.id,
        documentVersionId: job.documentVersionId,
        sourceId: job.sourceId,
        sourceType: job.sourceType,
        sourceVersion: job.sourceVersion,
        strategyKey: job.strategyKey,
        strategyVersion: job.strategyVersion,
        workspaceId: job.workspaceId,
      },
    });
    await transaction.knowledgeChunk.createMany({
      data: chunks.map((chunk) => ({
        characterEnd: chunk.characterEnd,
        characterStart: chunk.characterStart,
        chunkSetId: chunkSet.id,
        metadata: chunk.metadata,
        ordinal: chunk.ordinal,
        sha256: chunk.sha256,
        text: chunk.text,
        tokenEstimate: chunk.tokenEstimate,
      })),
    });
    const completedAt = new Date();
    await transaction.knowledgeChunkingJob.update({
      where: { id: job.id },
      data: { completedAt, status: KnowledgeChunkingJobStatus.SUCCEEDED },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_CHUNKING_SUCCEEDED,
      actorUserId: job.requestedByUserId,
      metadata: {
        chunkCount: chunks.length,
        chunkSetId: chunkSet.id,
        sourceId: job.sourceId,
        sourceType: job.sourceType,
        sourceVersion: job.sourceVersion,
        strategyKey: job.strategyKey,
        strategyVersion: job.strategyVersion,
      },
      organizationId: job.workspace.organizationId,
      targetId: job.id,
      targetType: AuditTargetType.KNOWLEDGE_CHUNKING_JOB,
      workspaceId: job.workspaceId,
    });
  });
}

async function failKnowledgeChunkingJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  failure: { code: string; message: string },
) {
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.knowledgeChunkingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status !== KnowledgeChunkingJobStatus.PROCESSING) {
      throw new KnowledgeChunkingConflictError('The chunking job is no longer active.');
    }
    const completedAt = new Date();
    await transaction.knowledgeChunkingJob.update({
      where: { id: job.id },
      data: {
        completedAt,
        errorMessage: failure.message,
        status: KnowledgeChunkingJobStatus.FAILED,
      },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_CHUNKING_FAILED,
      actorUserId: job.requestedByUserId,
      metadata: {
        errorCode: failure.code,
        sourceId: job.sourceId,
        sourceType: job.sourceType,
        sourceVersion: job.sourceVersion,
        strategyKey: job.strategyKey,
        strategyVersion: job.strategyVersion,
      },
      organizationId: job.workspace.organizationId,
      targetId: job.id,
      targetType: AuditTargetType.KNOWLEDGE_CHUNKING_JOB,
      workspaceId: job.workspaceId,
    });
  });
}

export async function executeKnowledgeChunkingJob(
  prisma: PrismaClient,
  dependencies: KnowledgeChunkingWorkerDependencies,
  jobId: string,
) {
  const job = await claimKnowledgeChunkingJob(prisma, jobId);
  try {
    await requireKnowledgeWorkspaceAccess(prisma, job.requestedByUserId, job.workspaceId, false);
    const source = getClaimedSource(job);
    if (
      source.documentStatus !== KnowledgeDocumentStatus.ACTIVE ||
      job.workspace.status !== WorkspaceStatus.ACTIVE ||
      job.workspace.organization.status !== OrganizationStatus.ACTIVE
    ) {
      throw new KnowledgeChunkingStateError(
        'Archived knowledge cannot be chunked.',
        'knowledge_archived',
      );
    }
    const strategy = dependencies.strategies.getVersion(job.strategyKey, job.strategyVersion);
    await completeKnowledgeChunkingJob(prisma, job, strategy.chunk(source.text));
  } catch (error) {
    await failKnowledgeChunkingJob(prisma, job, failureFrom(error));
  }
}

export async function listKnowledgeChunkSets(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  sourceType: KnowledgeChunkSourceType,
  sourceId: string,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  return prisma.knowledgeChunkSet.findMany({
    where: { sourceId, sourceType, workspaceId },
    include: { chunks: { orderBy: { ordinal: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getKnowledgeChunkingOverview(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  documentSlug: string,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  const document = await findKnowledgeDocument(prisma, workspaceId, documentSlug, true);
  const attachments = await prisma.knowledgeAttachment.findMany({
    where: { documentId: document.id, status: KnowledgeAttachmentStatus.ACTIVE, workspaceId },
    select: {
      id: true,
      extractions: {
        orderBy: { extractionNumber: 'desc' },
        select: { extractionNumber: true },
        take: 1,
      },
    },
  });
  const sources = [
    {
      sourceId: document.id,
      sourceType: KnowledgeChunkSourceType.MARKDOWN_DOCUMENT,
      sourceVersion: document.version,
    },
    ...attachments.flatMap((attachment) =>
      attachment.extractions[0]
        ? [
            {
              sourceId: attachment.id,
              sourceType: KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION,
              sourceVersion: attachment.extractions[0].extractionNumber,
            },
          ]
        : [],
    ),
  ];
  const jobs = await prisma.knowledgeChunkingJob.findMany({
    where: { OR: sources, workspaceId },
    include: { chunkSet: { select: { chunkCount: true, id: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (!latest.has(job.sourceId)) latest.set(job.sourceId, job);
  }
  return {
    attachments: Object.fromEntries(
      attachments.map((attachment) => [attachment.id, latest.get(attachment.id) ?? null]),
    ),
    document: latest.get(document.id) ?? null,
  };
}
