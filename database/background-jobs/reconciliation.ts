import { readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  BackgroundJobStatus,
  DocumentProcessingJobStatus,
  KnowledgeAttachmentProcessingStatus,
  KnowledgeAttachmentStatus,
  KnowledgeChunkingJobStatus,
  KnowledgeEmbeddingJobStatus,
  type PrismaClient,
} from '../generated/client/client';
import {
  StorageObjectNotFoundError,
  type ObjectStorage,
} from '../../services/storage/object-storage';

export type BackgroundJobReconciliationReport = Readonly<{
  queuedNeverStarted: string[];
  expiredProcessingLeases: string[];
  attachmentsWithoutBinaries: string[];
  binariesWithoutMetadata: string[];
  incompleteExtractions: string[];
  incompleteChunkSets: string[];
  incompleteEmbeddingSets: string[];
  unprocessedAttachments: string[];
  unchunkedExtractions: string[];
  unembeddedChunkSets: string[];
  attachmentMetadataMismatches: string[];
  archivedAttachments: string[];
  failedBackgroundJobs: string[];
  orphanChunks: string[];
  orphanEmbeddings: string[];
}>;

const RECONCILIATION_PAGE_SIZE = 200;
const RECONCILIATION_REPORT_LIMIT = 1_000;

function appendBounded(target: string[], value: string): void {
  if (target.length < RECONCILIATION_REPORT_LIMIT) target.push(value);
}

async function listLocalStorageKeys(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const parent = 'parentPath' in entry ? entry.parentPath : root;
        return relative(root, resolve(parent, entry.name)).split(sep).join('/');
      })
      .sort();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function createBackgroundJobReconciliationReport(
  prisma: PrismaClient,
  storage: ObjectStorage,
  localStorageRoot?: string,
  queuedAgeMs = 5 * 60_000,
): Promise<BackgroundJobReconciliationReport> {
  const queuedBefore = new Date(Date.now() - queuedAgeMs);
  const now = new Date();
  const [
    queued,
    expired,
    extractionJobs,
    chunkingJobs,
    embeddingJobs,
    unprocessedAttachments,
    archivedAttachments,
    failedBackgroundJobs,
    unchunkedExtractions,
    unembeddedChunkSets,
    orphanChunks,
    orphanEmbeddings,
  ] = await Promise.all([
    prisma.backgroundJob.findMany({
      where: {
        availableAt: { lte: now },
        createdAt: { lte: queuedBefore },
        status: BackgroundJobStatus.QUEUED,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.backgroundJob.findMany({
      where: { leaseExpiresAt: { lte: now }, status: BackgroundJobStatus.PROCESSING },
      orderBy: { leaseExpiresAt: 'asc' },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.documentProcessingJob.findMany({
      where: { extraction: null, status: DocumentProcessingJobStatus.SUCCEEDED },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.knowledgeChunkingJob.findMany({
      where: { chunkSet: null, status: KnowledgeChunkingJobStatus.SUCCEEDED },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.knowledgeEmbeddingJob.findMany({
      where: { embeddingSet: null, status: KnowledgeEmbeddingJobStatus.SUCCEEDED },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.knowledgeAttachment.findMany({
      where: {
        mimeType: {
          in: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ],
        },
        processingJobs: { none: {} },
        processingStatus: KnowledgeAttachmentProcessingStatus.UPLOADED,
        status: KnowledgeAttachmentStatus.ACTIVE,
      },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.knowledgeAttachment.findMany({
      where: { status: KnowledgeAttachmentStatus.ARCHIVED },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.backgroundJob.findMany({
      where: { status: BackgroundJobStatus.FAILED },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
      take: RECONCILIATION_REPORT_LIMIT,
    }),
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT extraction."id"
      FROM "knowledge_attachment_extractions" extraction
      JOIN "knowledge_attachments" attachment
        ON attachment."id" = extraction."attachmentId"
       AND attachment."status" = 'ACTIVE'::"KnowledgeAttachmentStatus"
      WHERE NOT EXISTS (
        SELECT 1 FROM "knowledge_attachment_extractions" newer
        WHERE newer."attachmentId" = extraction."attachmentId"
          AND newer."extractionNumber" > extraction."extractionNumber"
      )
        AND NOT EXISTS (
          SELECT 1 FROM "knowledge_chunk_sets" chunk_set
          WHERE chunk_set."attachmentExtractionId" = extraction."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "knowledge_chunking_jobs" chunk_job
          WHERE chunk_job."attachmentExtractionId" = extraction."id"
            AND chunk_job."status" IN (
              'QUEUED'::"KnowledgeChunkingJobStatus",
              'PROCESSING'::"KnowledgeChunkingJobStatus"
            )
        )
      ORDER BY extraction."createdAt" ASC, extraction."id" ASC
      LIMIT ${RECONCILIATION_REPORT_LIMIT}
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT chunk_set."id"
      FROM "knowledge_chunk_sets" chunk_set
      JOIN "knowledge_chunking_jobs" chunk_job
        ON chunk_job."id" = chunk_set."createdByJobId"
       AND chunk_job."status" = 'SUCCEEDED'::"KnowledgeChunkingJobStatus"
      WHERE NOT EXISTS (
        SELECT 1 FROM "knowledge_chunk_sets" newer
        WHERE newer."workspaceId" = chunk_set."workspaceId"
          AND newer."sourceType" = chunk_set."sourceType"
          AND newer."sourceId" = chunk_set."sourceId"
          AND (
            newer."sourceVersion" > chunk_set."sourceVersion"
            OR (newer."sourceVersion" = chunk_set."sourceVersion"
              AND newer."createdAt" > chunk_set."createdAt")
          )
      )
        AND NOT EXISTS (
          SELECT 1 FROM "knowledge_embedding_sets" embedding_set
          WHERE embedding_set."chunkSetId" = chunk_set."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "knowledge_embedding_jobs" embedding_job
          WHERE embedding_job."chunkSetId" = chunk_set."id"
            AND embedding_job."status" IN (
              'QUEUED'::"KnowledgeEmbeddingJobStatus",
              'PROCESSING'::"KnowledgeEmbeddingJobStatus"
            )
        )
      ORDER BY chunk_set."createdAt" ASC, chunk_set."id" ASC
      LIMIT ${RECONCILIATION_REPORT_LIMIT}
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT chunk."id"
      FROM "knowledge_chunks" chunk
      LEFT JOIN "knowledge_chunk_sets" chunk_set ON chunk_set."id" = chunk."chunkSetId"
      WHERE chunk_set."id" IS NULL
      ORDER BY chunk."id" ASC
      LIMIT ${RECONCILIATION_REPORT_LIMIT}
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT embedding."id"
      FROM "knowledge_embeddings" embedding
      LEFT JOIN "knowledge_embedding_sets" embedding_set
        ON embedding_set."id" = embedding."embeddingSetId"
      LEFT JOIN "knowledge_chunks" chunk ON chunk."id" = embedding."chunkId"
      WHERE embedding_set."id" IS NULL OR chunk."id" IS NULL
      ORDER BY embedding."id" ASC
      LIMIT ${RECONCILIATION_REPORT_LIMIT}
    `,
  ]);

  const attachmentsWithoutBinaries: string[] = [];
  const attachmentMetadataMismatches: string[] = [];
  let attachmentCursor: string | undefined;
  do {
    const attachments = await prisma.knowledgeAttachment.findMany({
      cursor: attachmentCursor ? { id: attachmentCursor } : undefined,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        mimeType: true,
        sizeBytes: true,
        storageCrc32c: true,
        storageEtag: true,
        storageGeneration: true,
        storageKey: true,
      },
      skip: attachmentCursor ? 1 : 0,
      take: RECONCILIATION_PAGE_SIZE,
    });
    for (const attachment of attachments) {
      try {
        const metadata = storage.getObjectMetadata
          ? await storage.getObjectMetadata(attachment.storageKey)
          : null;
        if (metadata) {
          const mismatch =
            metadata.sizeBytes !== attachment.sizeBytes ||
            (metadata.contentType !== null && metadata.contentType !== attachment.mimeType) ||
            (attachment.storageGeneration !== null &&
              metadata.generation !== attachment.storageGeneration) ||
            (attachment.storageCrc32c !== null && metadata.crc32c !== attachment.storageCrc32c) ||
            (attachment.storageEtag !== null && metadata.etag !== attachment.storageEtag);
          if (mismatch) appendBounded(attachmentMetadataMismatches, attachment.id);
        } else {
          await storage.getObject(attachment.storageKey, {
            generation: attachment.storageGeneration,
          });
        }
      } catch (error) {
        if (error instanceof StorageObjectNotFoundError) {
          appendBounded(attachmentsWithoutBinaries, attachment.id);
          continue;
        }
        throw error;
      }
    }
    attachmentCursor = attachments.at(-1)?.id;
    if (attachments.length < RECONCILIATION_PAGE_SIZE) attachmentCursor = undefined;
  } while (attachmentCursor);

  const binariesWithoutMetadata: string[] = [];
  if (storage.listObjects) {
    let pageToken: string | undefined;
    do {
      const page = await storage.listObjects({ pageSize: RECONCILIATION_PAGE_SIZE, pageToken });
      const metadataRows = await prisma.knowledgeAttachment.findMany({
        where: { storageKey: { in: page.items.map((item) => item.key) } },
        select: { storageKey: true },
      });
      const metadataKeys = new Set(metadataRows.map((row) => row.storageKey));
      for (const item of page.items) {
        if (!metadataKeys.has(item.key)) appendBounded(binariesWithoutMetadata, item.key);
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
  } else if (localStorageRoot) {
    const localKeys = await listLocalStorageKeys(localStorageRoot);
    for (const key of localKeys.slice(0, RECONCILIATION_REPORT_LIMIT)) {
      const metadata = await prisma.knowledgeAttachment.findUnique({
        where: { storageKey: key },
        select: { id: true },
      });
      if (!metadata) appendBounded(binariesWithoutMetadata, key);
    }
  }

  return {
    archivedAttachments: archivedAttachments.map((attachment) => attachment.id),
    attachmentMetadataMismatches,
    attachmentsWithoutBinaries,
    binariesWithoutMetadata,
    expiredProcessingLeases: expired.map((job) => job.id),
    failedBackgroundJobs: failedBackgroundJobs.map((job) => job.id),
    incompleteChunkSets: chunkingJobs.map((job) => job.id),
    incompleteEmbeddingSets: embeddingJobs.map((job) => job.id),
    incompleteExtractions: extractionJobs.map((job) => job.id),
    orphanChunks: orphanChunks.map((row) => row.id),
    orphanEmbeddings: orphanEmbeddings.map((row) => row.id),
    queuedNeverStarted: queued.map((job) => job.id),
    unchunkedExtractions: unchunkedExtractions.map((row) => row.id),
    unembeddedChunkSets: unembeddedChunkSets.map((row) => row.id),
    unprocessedAttachments: unprocessedAttachments.map((attachment) => attachment.id),
  };
}
