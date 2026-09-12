import {
  BackgroundJobKind,
  DocumentProcessingJobStatus,
  KnowledgeAttachmentProcessingStatus,
  KnowledgeAttachmentStatus,
  KnowledgeChunkSourceType,
  KnowledgeChunkingJobStatus,
  KnowledgeEmbeddingJobStatus,
  type BackgroundJob,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import {
  executeDocumentProcessingJob,
  type DocumentProcessingWorkerDependencies,
} from '../knowledge/document-processing';
import {
  KnowledgeChunkingConflictError,
  executeKnowledgeChunkingJob,
  requestKnowledgeAttachmentChunking,
  type KnowledgeChunkingWorkerDependencies,
} from '../knowledge/knowledge-chunking';
import {
  KnowledgeEmbeddingConflictError,
  executeKnowledgeEmbeddingJob,
  requestKnowledgeChunkSetEmbedding,
  type KnowledgeEmbeddingWorkerDependencies,
} from '../knowledge/knowledge-embeddings';
import { PostgresBackgroundJobQueue } from '../../services/document-processing/processing-queue';
import {
  BackgroundJobExecutionError,
  claimBackgroundJobById,
  executeClaimedBackgroundJob,
  findDurableJobByDomainReference,
  type BackgroundJobHandler,
  type BackgroundJobRuntimeOptions,
  type ExpiredLeaseRecoveryHook,
} from './runtime';

type Transaction = Prisma.TransactionClient;
const durableQueue = new PostgresBackgroundJobQueue();

export type DomainBackgroundJobDependencies = Readonly<{
  documentProcessing: DocumentProcessingWorkerDependencies;
  knowledgeChunking: KnowledgeChunkingWorkerDependencies;
  knowledgeEmbedding?: KnowledgeEmbeddingWorkerDependencies;
}>;

async function updateAttachmentLifecycleForChunkSet(
  prisma: PrismaClient,
  chunkSetId: string,
  processingStatus: KnowledgeAttachmentProcessingStatus,
): Promise<void> {
  const chunkSet = await prisma.knowledgeChunkSet.findUnique({
    where: { id: chunkSetId },
    select: {
      attachmentExtraction: {
        select: { attachmentId: true },
      },
    },
  });
  const attachmentId = chunkSet?.attachmentExtraction?.attachmentId;
  if (!attachmentId) return;
  if (processingStatus === KnowledgeAttachmentProcessingStatus.READY) {
    await prisma.knowledgeAttachment.updateMany({
      where: {
        id: attachmentId,
        processingStatus: {
          in: [
            KnowledgeAttachmentProcessingStatus.CHUNKING,
            KnowledgeAttachmentProcessingStatus.FAILED,
          ],
        },
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.EMBEDDING,
        updatedAt: new Date(),
      },
    });
    await prisma.knowledgeAttachment.updateMany({
      where: {
        id: attachmentId,
        processingStatus: KnowledgeAttachmentProcessingStatus.EMBEDDING,
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      data: { processingStatus, updatedAt: new Date() },
    });
    return;
  }
  if (processingStatus === KnowledgeAttachmentProcessingStatus.EMBEDDING) {
    await prisma.knowledgeAttachment.updateMany({
      where: {
        id: attachmentId,
        processingStatus: {
          in: [
            KnowledgeAttachmentProcessingStatus.CHUNKING,
            KnowledgeAttachmentProcessingStatus.FAILED,
            KnowledgeAttachmentProcessingStatus.READY,
          ],
        },
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      data: { processingStatus, updatedAt: new Date() },
    });
    return;
  }
  if (processingStatus === KnowledgeAttachmentProcessingStatus.FAILED) {
    await prisma.knowledgeAttachment.updateMany({
      where: {
        id: attachmentId,
        processingStatus: {
          in: [
            KnowledgeAttachmentProcessingStatus.CHUNKING,
            KnowledgeAttachmentProcessingStatus.EMBEDDING,
          ],
        },
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      data: { processingStatus, updatedAt: new Date() },
    });
    return;
  }
  throw new BackgroundJobExecutionError(
    'The requested attachment lifecycle transition is unsupported.',
    'attachment_state_transition_invalid',
    false,
  );
}

async function ensureEmbeddingRequested(
  prisma: PrismaClient,
  dependencies: KnowledgeEmbeddingWorkerDependencies,
  actorUserId: string,
  workspaceId: string,
  chunkSetId: string,
): Promise<void> {
  const provider = dependencies.providers.getCurrent();
  const existing = await prisma.knowledgeEmbeddingJob.findFirst({
    where: {
      chunkSetId,
      modelKey: provider.modelKey,
      modelVersion: provider.modelVersion,
      providerKey: provider.providerKey,
      status: {
        in: [
          KnowledgeEmbeddingJobStatus.QUEUED,
          KnowledgeEmbeddingJobStatus.PROCESSING,
          KnowledgeEmbeddingJobStatus.SUCCEEDED,
        ],
      },
      workspaceId,
    },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  });
  if (existing?.status === KnowledgeEmbeddingJobStatus.SUCCEEDED) {
    await updateAttachmentLifecycleForChunkSet(
      prisma,
      chunkSetId,
      KnowledgeAttachmentProcessingStatus.READY,
    );
    return;
  }
  if (!existing) {
    try {
      await requestKnowledgeChunkSetEmbedding(
        prisma,
        { providers: dependencies.providers, queue: durableQueue },
        actorUserId,
        workspaceId,
        chunkSetId,
      );
    } catch (error) {
      if (!(error instanceof KnowledgeEmbeddingConflictError)) throw error;
    }
  }
  await updateAttachmentLifecycleForChunkSet(
    prisma,
    chunkSetId,
    KnowledgeAttachmentProcessingStatus.EMBEDDING,
  );
}

async function ensureAttachmentChunkingRequested(
  prisma: PrismaClient,
  dependencies: DomainBackgroundJobDependencies,
  processingJobId: string,
): Promise<void> {
  const processingJob = await prisma.documentProcessingJob.findUnique({
    where: { id: processingJobId },
    include: {
      attachment: { include: { document: true } },
      extraction: true,
    },
  });
  if (!processingJob?.extraction) {
    throw new BackgroundJobExecutionError(
      'The successful extraction is missing its immutable result.',
      'extraction_result_missing',
      true,
    );
  }
  const existingSet = await prisma.knowledgeChunkSet.findFirst({
    where: {
      attachmentExtractionId: processingJob.extraction.id,
      workspaceId: processingJob.workspaceId,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existingSet) {
    if (dependencies.knowledgeEmbedding) {
      await ensureEmbeddingRequested(
        prisma,
        dependencies.knowledgeEmbedding,
        processingJob.requestedByUserId,
        processingJob.workspaceId,
        existingSet.id,
      );
    }
    return;
  }
  await prisma.knowledgeAttachment.updateMany({
    where: { id: processingJob.attachmentId, status: KnowledgeAttachmentStatus.ACTIVE },
    data: { processingStatus: KnowledgeAttachmentProcessingStatus.CHUNKING, updatedAt: new Date() },
  });
  try {
    await requestKnowledgeAttachmentChunking(
      prisma,
      { queue: durableQueue, strategies: dependencies.knowledgeChunking.strategies },
      processingJob.requestedByUserId,
      processingJob.workspaceId,
      processingJob.attachment.document.slug,
      processingJob.attachmentId,
    );
  } catch (error) {
    if (!(error instanceof KnowledgeChunkingConflictError)) throw error;
  }
}

async function runDocumentExtraction(
  prisma: PrismaClient,
  dependencies: DomainBackgroundJobDependencies,
  job: BackgroundJob,
): Promise<void> {
  const current = await prisma.documentProcessingJob.findUnique({ where: { id: job.domainJobId } });
  if (!current) {
    throw new BackgroundJobExecutionError(
      'The document-processing job no longer exists.',
      'domain_job_missing',
      false,
    );
  }
  if (current.status === DocumentProcessingJobStatus.SUCCEEDED) {
    await ensureAttachmentChunkingRequested(prisma, dependencies, current.id);
    return;
  }
  if (current.status === DocumentProcessingJobStatus.FAILED) {
    throw new BackgroundJobExecutionError(
      'Document processing reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await executeDocumentProcessingJob(prisma, dependencies.documentProcessing, current.id);
  const completed = await prisma.documentProcessingJob.findUnique({ where: { id: current.id } });
  if (completed?.status !== DocumentProcessingJobStatus.SUCCEEDED) {
    throw new BackgroundJobExecutionError(
      'Document processing reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await ensureAttachmentChunkingRequested(prisma, dependencies, current.id);
}

async function runKnowledgeChunking(
  prisma: PrismaClient,
  dependencies: DomainBackgroundJobDependencies,
  job: BackgroundJob,
): Promise<void> {
  const current = await prisma.knowledgeChunkingJob.findUnique({ where: { id: job.domainJobId } });
  if (!current) {
    throw new BackgroundJobExecutionError(
      'The Knowledge chunking job no longer exists.',
      'domain_job_missing',
      false,
    );
  }
  if (current.status === KnowledgeChunkingJobStatus.SUCCEEDED) {
    const existingSet = await prisma.knowledgeChunkSet.findUnique({
      where: { createdByJobId: current.id },
      select: { id: true },
    });
    if (existingSet && dependencies.knowledgeEmbedding) {
      await ensureEmbeddingRequested(
        prisma,
        dependencies.knowledgeEmbedding,
        current.requestedByUserId,
        current.workspaceId,
        existingSet.id,
      );
    }
    return;
  }
  if (current.status === KnowledgeChunkingJobStatus.FAILED) {
    throw new BackgroundJobExecutionError(
      'Knowledge chunking reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await executeKnowledgeChunkingJob(prisma, dependencies.knowledgeChunking, current.id);
  const completed = await prisma.knowledgeChunkingJob.findUnique({ where: { id: current.id } });
  if (completed?.status !== KnowledgeChunkingJobStatus.SUCCEEDED) {
    if (
      completed?.status === KnowledgeChunkingJobStatus.FAILED &&
      current.sourceType === KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION
    ) {
      await prisma.knowledgeAttachment.updateMany({
        where: { id: current.sourceId, status: KnowledgeAttachmentStatus.ACTIVE },
        data: {
          processingStatus: KnowledgeAttachmentProcessingStatus.FAILED,
          updatedAt: new Date(),
        },
      });
    }
    throw new BackgroundJobExecutionError(
      'Knowledge chunking reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  const chunkSet = await prisma.knowledgeChunkSet.findUniqueOrThrow({
    where: { createdByJobId: current.id },
    select: { id: true },
  });
  if (dependencies.knowledgeEmbedding) {
    await ensureEmbeddingRequested(
      prisma,
      dependencies.knowledgeEmbedding,
      current.requestedByUserId,
      current.workspaceId,
      chunkSet.id,
    );
  }
}

async function runKnowledgeEmbedding(
  prisma: PrismaClient,
  dependencies: KnowledgeEmbeddingWorkerDependencies | undefined,
  job: BackgroundJob,
): Promise<void> {
  if (!dependencies) {
    throw new BackgroundJobExecutionError(
      'No embedding handler is registered.',
      'handler_unavailable',
      false,
    );
  }
  const current = await prisma.knowledgeEmbeddingJob.findUnique({
    where: { id: job.domainJobId },
  });
  if (!current) {
    throw new BackgroundJobExecutionError(
      'The Knowledge embedding job no longer exists.',
      'domain_job_missing',
      false,
    );
  }
  if (current.status === KnowledgeEmbeddingJobStatus.SUCCEEDED) {
    await updateAttachmentLifecycleForChunkSet(
      prisma,
      current.chunkSetId,
      KnowledgeAttachmentProcessingStatus.READY,
    );
    return;
  }
  if (current.status === KnowledgeEmbeddingJobStatus.FAILED) {
    await updateAttachmentLifecycleForChunkSet(
      prisma,
      current.chunkSetId,
      KnowledgeAttachmentProcessingStatus.FAILED,
    );
    throw new BackgroundJobExecutionError(
      'Knowledge embedding reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await executeKnowledgeEmbeddingJob(
    prisma,
    dependencies,
    current.id,
    job.attemptCount < job.maxAttempts,
  );
  const completed = await prisma.knowledgeEmbeddingJob.findUnique({
    where: { id: current.id },
  });
  if (completed?.status !== KnowledgeEmbeddingJobStatus.SUCCEEDED) {
    if (completed?.status === KnowledgeEmbeddingJobStatus.FAILED) {
      await updateAttachmentLifecycleForChunkSet(
        prisma,
        current.chunkSetId,
        KnowledgeAttachmentProcessingStatus.FAILED,
      );
    }
    throw new BackgroundJobExecutionError(
      'Knowledge embedding reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await updateAttachmentLifecycleForChunkSet(
    prisma,
    current.chunkSetId,
    KnowledgeAttachmentProcessingStatus.READY,
  );
}

export function createDomainBackgroundJobHandler(
  prisma: PrismaClient,
  dependencies: DomainBackgroundJobDependencies,
): BackgroundJobHandler {
  return async (job) => {
    switch (job.kind) {
      case BackgroundJobKind.DOCUMENT_EXTRACTION:
        await runDocumentExtraction(prisma, dependencies, job);
        return;
      case BackgroundJobKind.KNOWLEDGE_CHUNKING:
        await runKnowledgeChunking(prisma, dependencies, job);
        return;
      case BackgroundJobKind.KNOWLEDGE_EMBEDDING:
        await runKnowledgeEmbedding(prisma, dependencies.knowledgeEmbedding, job);
        return;
    }
  };
}

async function recoverDocumentProcessingDomainJob(
  transaction: Transaction,
  job: BackgroundJob,
  terminal: boolean,
): Promise<void> {
  const domainJob = await transaction.documentProcessingJob.findUnique({
    where: { id: job.domainJobId },
    include: { attachment: { include: { workspace: true } } },
  });
  if (!domainJob || domainJob.status !== DocumentProcessingJobStatus.PROCESSING) return;
  const timestamp = new Date();
  if (!terminal) {
    await transaction.knowledgeAttachment.update({
      where: { id: domainJob.attachmentId },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.UPLOADED,
        updatedAt: timestamp,
      },
    });
    await transaction.documentProcessingJob.update({
      where: { id: domainJob.id },
      data: {
        completedAt: null,
        errorMessage: null,
        startedAt: null,
        status: DocumentProcessingJobStatus.QUEUED,
      },
    });
    return;
  }
  await transaction.knowledgeAttachment.update({
    where: { id: domainJob.attachmentId },
    data: { processingStatus: KnowledgeAttachmentProcessingStatus.FAILED, updatedAt: timestamp },
  });
  await transaction.documentProcessingJob.update({
    where: { id: domainJob.id },
    data: {
      completedAt: timestamp,
      errorMessage: 'Processing stopped after the final worker lease expired.',
      status: DocumentProcessingJobStatus.FAILED,
    },
  });
  await appendAuditEvent(transaction, {
    action: AuditAction.KNOWLEDGE_ATTACHMENT_PROCESSING_FAILED,
    actorUserId: domainJob.requestedByUserId,
    metadata: { errorCode: 'lease_expired', jobId: domainJob.id },
    organizationId: domainJob.attachment.workspace.organizationId,
    targetId: domainJob.attachmentId,
    targetType: AuditTargetType.KNOWLEDGE_ATTACHMENT,
    workspaceId: domainJob.workspaceId,
  });
}

async function recoverKnowledgeChunkingDomainJob(
  transaction: Transaction,
  job: BackgroundJob,
  terminal: boolean,
): Promise<void> {
  const domainJob = await transaction.knowledgeChunkingJob.findUnique({
    where: { id: job.domainJobId },
    include: { workspace: true },
  });
  if (!domainJob || domainJob.status !== KnowledgeChunkingJobStatus.PROCESSING) return;
  if (!terminal) {
    await transaction.knowledgeChunkingJob.update({
      where: { id: domainJob.id },
      data: {
        completedAt: null,
        errorMessage: null,
        startedAt: null,
        status: KnowledgeChunkingJobStatus.QUEUED,
      },
    });
    return;
  }
  const completedAt = new Date();
  if (domainJob.sourceType === KnowledgeChunkSourceType.ATTACHMENT_EXTRACTION) {
    await transaction.knowledgeAttachment.updateMany({
      where: {
        id: domainJob.sourceId,
        processingStatus: KnowledgeAttachmentProcessingStatus.CHUNKING,
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.FAILED,
        updatedAt: completedAt,
      },
    });
  }
  await transaction.knowledgeChunkingJob.update({
    where: { id: domainJob.id },
    data: {
      completedAt,
      errorMessage: 'Chunking stopped after the final worker lease expired.',
      status: KnowledgeChunkingJobStatus.FAILED,
    },
  });
  await appendAuditEvent(transaction, {
    action: AuditAction.KNOWLEDGE_CHUNKING_FAILED,
    actorUserId: domainJob.requestedByUserId,
    metadata: {
      errorCode: 'lease_expired',
      sourceId: domainJob.sourceId,
      sourceType: domainJob.sourceType,
      sourceVersion: domainJob.sourceVersion,
      strategyKey: domainJob.strategyKey,
      strategyVersion: domainJob.strategyVersion,
    },
    organizationId: domainJob.workspace.organizationId,
    targetId: domainJob.id,
    targetType: AuditTargetType.KNOWLEDGE_CHUNKING_JOB,
    workspaceId: domainJob.workspaceId,
  });
}

async function recoverKnowledgeEmbeddingDomainJob(
  transaction: Transaction,
  job: BackgroundJob,
  terminal: boolean,
): Promise<void> {
  const domainJob = await transaction.knowledgeEmbeddingJob.findUnique({
    where: { id: job.domainJobId },
    include: { workspace: true },
  });
  if (!domainJob || domainJob.status !== KnowledgeEmbeddingJobStatus.PROCESSING) return;
  if (!terminal) {
    await transaction.knowledgeEmbeddingJob.update({
      where: { id: domainJob.id },
      data: {
        completedAt: null,
        errorMessage: null,
        startedAt: null,
        status: KnowledgeEmbeddingJobStatus.QUEUED,
      },
    });
    return;
  }
  const completedAt = new Date();
  const attachment = await transaction.knowledgeChunkSet.findUnique({
    where: { id: domainJob.chunkSetId },
    select: { attachmentExtraction: { select: { attachmentId: true } } },
  });
  if (attachment?.attachmentExtraction) {
    await transaction.knowledgeAttachment.updateMany({
      where: {
        id: attachment.attachmentExtraction.attachmentId,
        processingStatus: KnowledgeAttachmentProcessingStatus.EMBEDDING,
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      data: {
        processingStatus: KnowledgeAttachmentProcessingStatus.FAILED,
        updatedAt: completedAt,
      },
    });
  }
  await transaction.knowledgeEmbeddingJob.update({
    where: { id: domainJob.id },
    data: {
      completedAt,
      errorMessage: 'Embedding stopped after the final worker lease expired.',
      status: KnowledgeEmbeddingJobStatus.FAILED,
    },
  });
  await appendAuditEvent(transaction, {
    action: AuditAction.KNOWLEDGE_EMBEDDING_FAILED,
    actorUserId: domainJob.requestedByUserId,
    metadata: {
      chunkSetId: domainJob.chunkSetId,
      errorCode: 'lease_expired',
      modelKey: domainJob.modelKey,
      modelVersion: domainJob.modelVersion,
      providerKey: domainJob.providerKey,
      retryScheduled: false,
    },
    organizationId: domainJob.workspace.organizationId,
    targetId: domainJob.id,
    targetType: AuditTargetType.KNOWLEDGE_EMBEDDING_JOB,
    workspaceId: domainJob.workspaceId,
  });
}

export const recoverDomainJobAfterExpiredLease: ExpiredLeaseRecoveryHook = async (
  transaction,
  job,
  terminal,
) => {
  switch (job.kind) {
    case BackgroundJobKind.DOCUMENT_EXTRACTION:
      await recoverDocumentProcessingDomainJob(transaction, job, terminal);
      return;
    case BackgroundJobKind.KNOWLEDGE_CHUNKING:
      await recoverKnowledgeChunkingDomainJob(transaction, job, terminal);
      return;
    case BackgroundJobKind.KNOWLEDGE_EMBEDDING:
      await recoverKnowledgeEmbeddingDomainJob(transaction, job, terminal);
      return;
  }
};

export async function executeDurableDomainJobByReference(
  prisma: PrismaClient,
  dependencies: DomainBackgroundJobDependencies,
  kind: BackgroundJobKind,
  domainJobId: string,
  workerId: string,
  options: BackgroundJobRuntimeOptions = {},
): Promise<void> {
  const durableJob = await findDurableJobByDomainReference(prisma, kind, domainJobId);
  if (!durableJob) {
    throw new BackgroundJobExecutionError(
      'The durable execution record was not found.',
      'durable_job_missing',
      false,
    );
  }
  const claimed = await claimBackgroundJobById(prisma, durableJob.id, workerId, options);
  if (!claimed) return;
  await executeClaimedBackgroundJob(
    prisma,
    claimed,
    createDomainBackgroundJobHandler(prisma, dependencies),
    options,
  );
}
