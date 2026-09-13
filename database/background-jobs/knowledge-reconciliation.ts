import {
  KnowledgeAttachmentProcessingStatus,
  KnowledgeAttachmentStatus,
  type PrismaClient,
} from '../generated/client/client';
import {
  DocumentProcessingConflictError,
  requestKnowledgeAttachmentProcessing,
} from '../knowledge/document-processing';
import {
  KnowledgeChunkingConflictError,
  requestKnowledgeAttachmentChunking,
} from '../knowledge/knowledge-chunking';
import {
  KnowledgeEmbeddingConflictError,
  requestKnowledgeChunkSetEmbedding,
} from '../knowledge/knowledge-embeddings';
import type { DocumentParserRegistry } from '../../services/document-processing/document-parser';
import { PostgresBackgroundJobQueue } from '../../services/document-processing/processing-queue';
import type { EmbeddingProviderRegistry } from '../../services/embeddings/embedding-provider';
import type { KnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';
import type { BackgroundJobReconciliationReport } from './reconciliation';

const queue = new PostgresBackgroundJobQueue();

export type KnowledgeLifecycleRepairDependencies = Readonly<{
  parsers: DocumentParserRegistry;
  providers: EmbeddingProviderRegistry;
  strategies: KnowledgeChunkingStrategyRegistry;
}>;

export type KnowledgeLifecycleRepairResult = Readonly<{
  chunkingRequested: number;
  embeddingRequested: number;
  failures: string[];
  processingRequested: number;
}>;

function isConflict(error: unknown): boolean {
  return (
    error instanceof DocumentProcessingConflictError ||
    error instanceof KnowledgeChunkingConflictError ||
    error instanceof KnowledgeEmbeddingConflictError
  );
}

/**
 * Repairs only missing durable pipeline requests. It never deletes binaries,
 * metadata, chunks, or embeddings, and it reuses normal authorization paths.
 */
export async function repairKnowledgeLifecycleDrift(
  prisma: PrismaClient,
  dependencies: KnowledgeLifecycleRepairDependencies,
  report: Pick<
    BackgroundJobReconciliationReport,
    'unchunkedExtractions' | 'unembeddedChunkSets' | 'unprocessedAttachments'
  >,
): Promise<KnowledgeLifecycleRepairResult> {
  let processingRequested = 0;
  let chunkingRequested = 0;
  let embeddingRequested = 0;
  const failures: string[] = [];

  for (const attachmentId of report.unprocessedAttachments) {
    const attachment = await prisma.knowledgeAttachment.findUnique({
      where: { id: attachmentId },
      include: { document: true },
    });
    if (!attachment || attachment.status !== KnowledgeAttachmentStatus.ACTIVE) continue;
    try {
      await requestKnowledgeAttachmentProcessing(
        prisma,
        { parsers: dependencies.parsers, queue },
        attachment.uploaderUserId,
        attachment.workspaceId,
        attachment.document.slug,
        attachment.id,
      );
      processingRequested += 1;
    } catch (error) {
      if (!isConflict(error)) failures.push(`attachment:${attachmentId}`);
    }
  }

  for (const extractionId of report.unchunkedExtractions) {
    const extraction = await prisma.knowledgeAttachmentExtraction.findUnique({
      where: { id: extractionId },
      include: { attachment: { include: { document: true } } },
    });
    if (!extraction || extraction.attachment.status !== KnowledgeAttachmentStatus.ACTIVE) continue;
    try {
      await requestKnowledgeAttachmentChunking(
        prisma,
        { queue, strategies: dependencies.strategies },
        extraction.attachment.uploaderUserId,
        extraction.workspaceId,
        extraction.attachment.document.slug,
        extraction.attachmentId,
      );
      await prisma.knowledgeAttachment.updateMany({
        where: {
          id: extraction.attachmentId,
          processingStatus: KnowledgeAttachmentProcessingStatus.PROCESSED,
          status: KnowledgeAttachmentStatus.ACTIVE,
        },
        data: {
          processingStatus: KnowledgeAttachmentProcessingStatus.CHUNKING,
          updatedAt: new Date(),
        },
      });
      chunkingRequested += 1;
    } catch (error) {
      if (!isConflict(error)) failures.push(`extraction:${extractionId}`);
    }
  }

  for (const chunkSetId of report.unembeddedChunkSets) {
    const chunkSet = await prisma.knowledgeChunkSet.findUnique({
      where: { id: chunkSetId },
      include: {
        attachmentExtraction: true,
        createdByJob: true,
      },
    });
    if (!chunkSet) continue;
    try {
      await requestKnowledgeChunkSetEmbedding(
        prisma,
        { providers: dependencies.providers, queue },
        chunkSet.createdByJob.requestedByUserId,
        chunkSet.workspaceId,
        chunkSet.id,
      );
      if (chunkSet.attachmentExtraction) {
        await prisma.knowledgeAttachment.updateMany({
          where: {
            id: chunkSet.attachmentExtraction.attachmentId,
            processingStatus: KnowledgeAttachmentProcessingStatus.PROCESSED,
            status: KnowledgeAttachmentStatus.ACTIVE,
          },
          data: {
            processingStatus: KnowledgeAttachmentProcessingStatus.CHUNKING,
            updatedAt: new Date(),
          },
        });
        await prisma.knowledgeAttachment.updateMany({
          where: {
            id: chunkSet.attachmentExtraction.attachmentId,
            processingStatus: KnowledgeAttachmentProcessingStatus.CHUNKING,
            status: KnowledgeAttachmentStatus.ACTIVE,
          },
          data: {
            processingStatus: KnowledgeAttachmentProcessingStatus.EMBEDDING,
            updatedAt: new Date(),
          },
        });
      }
      embeddingRequested += 1;
    } catch (error) {
      if (!isConflict(error)) failures.push(`chunk-set:${chunkSetId}`);
    }
  }

  return { chunkingRequested, embeddingRequested, failures, processingRequested };
}
