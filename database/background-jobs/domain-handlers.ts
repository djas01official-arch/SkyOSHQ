import {
  BackgroundJobKind,
  DocumentProcessingJobStatus,
  KnowledgeAttachmentProcessingStatus,
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
  executeKnowledgeChunkingJob,
  type KnowledgeChunkingWorkerDependencies,
} from '../knowledge/knowledge-chunking';
import {
  executeKnowledgeEmbeddingJob,
  type KnowledgeEmbeddingWorkerDependencies,
} from '../knowledge/knowledge-embeddings';
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

export type DomainBackgroundJobDependencies = Readonly<{
  documentProcessing: DocumentProcessingWorkerDependencies;
  knowledgeChunking: KnowledgeChunkingWorkerDependencies;
  knowledgeEmbedding?: KnowledgeEmbeddingWorkerDependencies;
}>;

async function runDocumentExtraction(
  prisma: PrismaClient,
  dependencies: DocumentProcessingWorkerDependencies,
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
  if (current.status === DocumentProcessingJobStatus.SUCCEEDED) return;
  if (current.status === DocumentProcessingJobStatus.FAILED) {
    throw new BackgroundJobExecutionError(
      'Document processing reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await executeDocumentProcessingJob(prisma, dependencies, current.id);
  const completed = await prisma.documentProcessingJob.findUnique({ where: { id: current.id } });
  if (completed?.status !== DocumentProcessingJobStatus.SUCCEEDED) {
    throw new BackgroundJobExecutionError(
      'Document processing reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
}

async function runKnowledgeChunking(
  prisma: PrismaClient,
  dependencies: KnowledgeChunkingWorkerDependencies,
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
  if (current.status === KnowledgeChunkingJobStatus.SUCCEEDED) return;
  if (current.status === KnowledgeChunkingJobStatus.FAILED) {
    throw new BackgroundJobExecutionError(
      'Knowledge chunking reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
  await executeKnowledgeChunkingJob(prisma, dependencies, current.id);
  const completed = await prisma.knowledgeChunkingJob.findUnique({ where: { id: current.id } });
  if (completed?.status !== KnowledgeChunkingJobStatus.SUCCEEDED) {
    throw new BackgroundJobExecutionError(
      'Knowledge chunking reached a failed state.',
      'domain_job_failed',
      false,
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
  if (current.status === KnowledgeEmbeddingJobStatus.SUCCEEDED) return;
  if (current.status === KnowledgeEmbeddingJobStatus.FAILED) {
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
    throw new BackgroundJobExecutionError(
      'Knowledge embedding reached a failed state.',
      'domain_job_failed',
      false,
    );
  }
}

export function createDomainBackgroundJobHandler(
  prisma: PrismaClient,
  dependencies: DomainBackgroundJobDependencies,
): BackgroundJobHandler {
  return async (job) => {
    switch (job.kind) {
      case BackgroundJobKind.DOCUMENT_EXTRACTION:
        await runDocumentExtraction(prisma, dependencies.documentProcessing, job);
        return;
      case BackgroundJobKind.KNOWLEDGE_CHUNKING:
        await runKnowledgeChunking(prisma, dependencies.knowledgeChunking, job);
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
