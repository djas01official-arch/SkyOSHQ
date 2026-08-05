import { createHash } from 'node:crypto';

import {
  BackgroundJobKind,
  KnowledgeAttachmentStatus,
  KnowledgeChunkingJobStatus,
  KnowledgeDocumentStatus,
  KnowledgeEmbeddingJobStatus,
  OrganizationStatus,
  Prisma,
  WorkspaceStatus,
  type PrismaClient,
} from '../generated/client/client';
import { appendAuditEvent, AuditAction, AuditTargetType } from '../audit/audit-event';
import {
  createDurableBackgroundJob,
  BackgroundJobExecutionError,
} from '../background-jobs/runtime';
import { requireKnowledgeWorkspaceAccess } from './knowledge-documents';
import type { BackgroundJobQueue } from '../../services/document-processing/processing-queue';
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';

type Transaction = Prisma.TransactionClient;

export class KnowledgeEmbeddingError extends Error {}
export class KnowledgeEmbeddingConflictError extends KnowledgeEmbeddingError {}
export class KnowledgeEmbeddingNotFoundError extends KnowledgeEmbeddingError {}
export class KnowledgeEmbeddingStateError extends KnowledgeEmbeddingError {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export type KnowledgeEmbeddingRequestDependencies = Readonly<{
  providers: EmbeddingProviderRegistry;
  queue: BackgroundJobQueue;
}>;

export type KnowledgeEmbeddingWorkerDependencies = Readonly<{
  providers: EmbeddingProviderRegistry;
}>;

type EmbeddingFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

function failureFrom(error: unknown): EmbeddingFailure {
  if (error instanceof EmbeddingProviderError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof KnowledgeEmbeddingStateError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: 'embedding_failed',
    message: 'Knowledge embedding failed.',
    retryable: true,
  };
}

async function findEmbeddableChunkSet(
  prisma: PrismaClient | Transaction,
  workspaceId: string,
  chunkSetId: string,
) {
  const chunkSet = await prisma.knowledgeChunkSet.findFirst({
    where: { id: chunkSetId, workspaceId },
    include: {
      attachmentExtraction: {
        include: { attachment: { include: { document: true } } },
      },
      chunks: { orderBy: { ordinal: 'asc' } },
      createdByJob: true,
      documentVersion: { include: { document: true } },
      workspace: { include: { organization: true } },
    },
  });
  if (!chunkSet) {
    throw new KnowledgeEmbeddingNotFoundError('The chunk set was not found in this workspace.');
  }
  if (
    chunkSet.createdByJob.status !== KnowledgeChunkingJobStatus.SUCCEEDED ||
    chunkSet.chunkCount < 1 ||
    chunkSet.chunks.length !== chunkSet.chunkCount
  ) {
    throw new KnowledgeEmbeddingStateError(
      'Only complete successful chunk sets can be embedded.',
      'chunk_set_incomplete',
    );
  }
  const document =
    chunkSet.documentVersion?.document ??
    chunkSet.attachmentExtraction?.attachment.document ??
    null;
  if (
    !document ||
    document.status !== KnowledgeDocumentStatus.ACTIVE ||
    chunkSet.workspace.status !== WorkspaceStatus.ACTIVE ||
    chunkSet.workspace.organization.status !== OrganizationStatus.ACTIVE ||
    (chunkSet.attachmentExtraction &&
      chunkSet.attachmentExtraction.attachment.status !== KnowledgeAttachmentStatus.ACTIVE)
  ) {
    throw new KnowledgeEmbeddingStateError(
      'Archived Knowledge sources cannot be embedded.',
      'knowledge_archived',
    );
  }
  return chunkSet;
}

export async function requestKnowledgeChunkSetEmbedding(
  prisma: PrismaClient,
  dependencies: KnowledgeEmbeddingRequestDependencies,
  actorUserId: string,
  workspaceId: string,
  chunkSetId: string,
) {
  const provider = dependencies.providers.getCurrent();
  const job = await prisma.$transaction(async (transaction) => {
    const access = await requireKnowledgeWorkspaceAccess(
      transaction,
      actorUserId,
      workspaceId,
      true,
    );
    await findEmbeddableChunkSet(transaction, workspaceId, chunkSetId);
    const active = await transaction.knowledgeEmbeddingJob.findFirst({
      where: {
        chunkSetId,
        modelKey: provider.modelKey,
        modelVersion: provider.modelVersion,
        providerKey: provider.providerKey,
        status: {
          in: [KnowledgeEmbeddingJobStatus.QUEUED, KnowledgeEmbeddingJobStatus.PROCESSING],
        },
        workspaceId,
      },
      select: { id: true },
    });
    if (active) {
      throw new KnowledgeEmbeddingConflictError(
        'This chunk set already has a pending embedding job for the selected model.',
      );
    }
    const created = await transaction.knowledgeEmbeddingJob.create({
      data: {
        chunkSetId,
        dimensions: provider.dimensions,
        modelKey: provider.modelKey,
        modelVersion: provider.modelVersion,
        providerKey: provider.providerKey,
        requestedByUserId: actorUserId,
        workspaceId,
      },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_EMBEDDING_REQUESTED,
      actorUserId,
      metadata: {
        chunkSetId,
        dimensions: provider.dimensions,
        modelKey: provider.modelKey,
        modelVersion: provider.modelVersion,
        providerKey: provider.providerKey,
      },
      organizationId: access.organizationId,
      targetId: created.id,
      targetType: AuditTargetType.KNOWLEDGE_EMBEDDING_JOB,
      workspaceId,
    });
    await createDurableBackgroundJob(transaction, {
      domainJobId: created.id,
      idempotencyKey: `knowledge-embedding:${created.id}`,
      kind: BackgroundJobKind.KNOWLEDGE_EMBEDDING,
      payload: { chunkSetId },
      requestedByUserId: actorUserId,
      workspaceId,
    });
    return created;
  });

  await dependencies.queue.enqueue(job.id);
  return prisma.knowledgeEmbeddingJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function claimKnowledgeEmbeddingJob(prisma: PrismaClient, jobId: string) {
  return prisma.$transaction(async (transaction) => {
    const job = await transaction.knowledgeEmbeddingJob.findUnique({
      where: { id: jobId },
      include: { workspace: true },
    });
    if (!job) throw new KnowledgeEmbeddingNotFoundError('The embedding job was not found.');
    if (job.status !== KnowledgeEmbeddingJobStatus.QUEUED) {
      throw new KnowledgeEmbeddingConflictError('The embedding job has already been claimed.');
    }
    const startedAt = new Date();
    await transaction.knowledgeEmbeddingJob.update({
      where: { id: job.id },
      data: { startedAt, status: KnowledgeEmbeddingJobStatus.PROCESSING },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_EMBEDDING_STARTED,
      actorUserId: job.requestedByUserId,
      metadata: {
        chunkSetId: job.chunkSetId,
        dimensions: job.dimensions,
        modelKey: job.modelKey,
        modelVersion: job.modelVersion,
        providerKey: job.providerKey,
      },
      organizationId: job.workspace.organizationId,
      targetId: job.id,
      targetType: AuditTargetType.KNOWLEDGE_EMBEDDING_JOB,
      workspaceId: job.workspaceId,
    });
    return job;
  });
}

function checksumInput(provider: EmbeddingProvider, text: string): string {
  return createHash('sha256')
    .update(
      `${provider.providerKey}\0${provider.modelKey}\0${provider.modelVersion}\0${provider.dimensions}\0${text}`,
      'utf8',
    )
    .digest('hex');
}

function validateVector(vector: readonly number[], dimensions: number): void {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new KnowledgeEmbeddingStateError(
      'The embedding provider returned an invalid vector dimension or value.',
      'provider_output_invalid',
    );
  }
}

async function embedChunks(provider: EmbeddingProvider, chunks: readonly { text: string }[]) {
  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += provider.maxBatchSize) {
    const batch = chunks.slice(offset, offset + provider.maxBatchSize);
    const output = await provider.embed(batch.map((chunk) => chunk.text));
    if (output.length !== batch.length) {
      throw new KnowledgeEmbeddingStateError(
        'The embedding provider returned the wrong number of vectors.',
        'provider_output_invalid',
      );
    }
    for (const vector of output) {
      validateVector(vector, provider.dimensions);
      vectors.push([...vector]);
    }
  }
  return vectors;
}

async function completeKnowledgeEmbeddingJob(
  prisma: PrismaClient,
  job: Awaited<ReturnType<typeof claimKnowledgeEmbeddingJob>>,
  provider: EmbeddingProvider,
  chunkSet: Awaited<ReturnType<typeof findEmbeddableChunkSet>>,
  vectors: readonly (readonly number[])[],
): Promise<void> {
  const inputs = chunkSet.chunks.map((chunk) => ({
    checksum: checksumInput(provider, chunk.text),
    chunk,
  }));
  const inputChecksum = createHash('sha256')
    .update(inputs.map((input) => input.checksum).join('\n'), 'utf8')
    .digest('hex');

  await prisma.$transaction(async (transaction) => {
    const current = await transaction.knowledgeEmbeddingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status !== KnowledgeEmbeddingJobStatus.PROCESSING) {
      throw new KnowledgeEmbeddingConflictError('The embedding job is no longer active.');
    }
    const embeddingSet = await transaction.knowledgeEmbeddingSet.create({
      data: {
        chunkSetId: chunkSet.id,
        createdByJobId: job.id,
        dimensions: provider.dimensions,
        embeddingCount: inputs.length,
        inputChecksum,
        modelKey: provider.modelKey,
        modelVersion: provider.modelVersion,
        providerKey: provider.providerKey,
        workspaceId: job.workspaceId,
      },
    });
    const rows = inputs.map((input, index) => {
      const vector = vectors[index];
      if (!vector) {
        throw new KnowledgeEmbeddingStateError(
          'An embedding vector is missing for a source chunk.',
          'provider_output_invalid',
        );
      }
      return Prisma.sql`(
        gen_random_uuid(), ${embeddingSet.id}::uuid, ${input.chunk.id}::uuid,
        ${input.chunk.ordinal}, ${input.chunk.sha256}, ${input.checksum},
        ${JSON.stringify(vector)}::vector, CURRENT_TIMESTAMP
      )`;
    });
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "knowledge_embeddings" (
        "id", "embeddingSetId", "chunkId", "ordinal", "chunkSha256",
        "inputChecksum", "vector", "createdAt"
      ) VALUES ${Prisma.join(rows)}
    `);
    const completedAt = new Date();
    await transaction.knowledgeEmbeddingJob.update({
      where: { id: job.id },
      data: { completedAt, status: KnowledgeEmbeddingJobStatus.SUCCEEDED },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_EMBEDDING_SUCCEEDED,
      actorUserId: job.requestedByUserId,
      metadata: {
        chunkSetId: chunkSet.id,
        embeddingCount: inputs.length,
        embeddingSetId: embeddingSet.id,
        inputChecksum,
        modelKey: provider.modelKey,
        modelVersion: provider.modelVersion,
        providerKey: provider.providerKey,
      },
      organizationId: job.workspace.organizationId,
      targetId: job.id,
      targetType: AuditTargetType.KNOWLEDGE_EMBEDDING_JOB,
      workspaceId: job.workspaceId,
    });
  });
}

async function transitionFailedEmbeddingJob(
  prisma: PrismaClient,
  job: Awaited<ReturnType<typeof claimKnowledgeEmbeddingJob>>,
  failure: EmbeddingFailure,
  retryAllowed: boolean,
): Promise<void> {
  const retry = failure.retryable && retryAllowed;
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.knowledgeEmbeddingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status !== KnowledgeEmbeddingJobStatus.PROCESSING) {
      throw new KnowledgeEmbeddingConflictError('The embedding job is no longer active.');
    }
    const completedAt = new Date();
    await transaction.knowledgeEmbeddingJob.update({
      where: { id: job.id },
      data: retry
        ? {
            completedAt: null,
            errorMessage: null,
            startedAt: null,
            status: KnowledgeEmbeddingJobStatus.QUEUED,
          }
        : {
            completedAt,
            errorMessage: failure.message,
            status: KnowledgeEmbeddingJobStatus.FAILED,
          },
    });
    await appendAuditEvent(transaction, {
      action: AuditAction.KNOWLEDGE_EMBEDDING_FAILED,
      actorUserId: job.requestedByUserId,
      metadata: {
        chunkSetId: job.chunkSetId,
        errorCode: failure.code,
        modelKey: job.modelKey,
        modelVersion: job.modelVersion,
        providerKey: job.providerKey,
        retryScheduled: retry,
      },
      organizationId: job.workspace.organizationId,
      targetId: job.id,
      targetType: AuditTargetType.KNOWLEDGE_EMBEDDING_JOB,
      workspaceId: job.workspaceId,
    });
  });
  if (retry) {
    throw new BackgroundJobExecutionError(failure.message, failure.code, true);
  }
}

export async function executeKnowledgeEmbeddingJob(
  prisma: PrismaClient,
  dependencies: KnowledgeEmbeddingWorkerDependencies,
  jobId: string,
  retryAllowed = true,
): Promise<void> {
  const job = await claimKnowledgeEmbeddingJob(prisma, jobId);
  try {
    await requireKnowledgeWorkspaceAccess(prisma, job.requestedByUserId, job.workspaceId, false);
    const chunkSet = await findEmbeddableChunkSet(prisma, job.workspaceId, job.chunkSetId);
    const provider = dependencies.providers.getVersion(
      job.providerKey,
      job.modelKey,
      job.modelVersion,
    );
    if (provider.dimensions !== job.dimensions) {
      throw new KnowledgeEmbeddingStateError(
        'The configured provider dimension does not match the embedding job.',
        'provider_dimension_mismatch',
      );
    }
    for (const chunk of chunkSet.chunks) {
      const actualChecksum = createHash('sha256').update(chunk.text, 'utf8').digest('hex');
      if (actualChecksum !== chunk.sha256) {
        throw new KnowledgeEmbeddingStateError(
          'A source chunk failed checksum verification.',
          'source_checksum_mismatch',
        );
      }
      if (chunk.text.length > provider.maxInputCharacters) {
        throw new KnowledgeEmbeddingStateError(
          'A source chunk exceeds the selected provider input limit.',
          'provider_input_limit_exceeded',
        );
      }
    }
    const vectors = await embedChunks(provider, chunkSet.chunks);
    await completeKnowledgeEmbeddingJob(prisma, job, provider, chunkSet, vectors);
  } catch (error) {
    await transitionFailedEmbeddingJob(prisma, job, failureFrom(error), retryAllowed);
  }
}

export async function listKnowledgeEmbeddingSets(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  chunkSetId: string,
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  await findEmbeddableChunkSet(prisma, workspaceId, chunkSetId);
  return prisma.knowledgeEmbeddingSet.findMany({
    where: { chunkSetId, workspaceId },
    orderBy: { createdAt: 'desc' },
    select: {
      chunkSetId: true,
      createdAt: true,
      dimensions: true,
      embeddingCount: true,
      id: true,
      inputChecksum: true,
      modelKey: true,
      modelVersion: true,
      providerKey: true,
    },
  });
}

export async function getKnowledgeEmbeddingOverview(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  chunkSetIds: readonly string[],
) {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  const jobs = await prisma.knowledgeEmbeddingJob.findMany({
    where: { chunkSetId: { in: [...chunkSetIds] }, workspaceId },
    include: { embeddingSet: true },
    orderBy: { createdAt: 'desc' },
  });
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (!latest.has(job.chunkSetId)) latest.set(job.chunkSetId, job);
  }
  return Object.fromEntries(
    chunkSetIds.map((chunkSetId) => [chunkSetId, latest.get(chunkSetId) ?? null]),
  );
}
