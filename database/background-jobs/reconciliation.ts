import { readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  BackgroundJobStatus,
  DocumentProcessingJobStatus,
  KnowledgeChunkingJobStatus,
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
}>;

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
  const [queued, expired, attachments, extractionJobs, chunkingJobs] = await Promise.all([
    prisma.backgroundJob.findMany({
      where: {
        availableAt: { lte: now },
        createdAt: { lte: queuedBefore },
        status: BackgroundJobStatus.QUEUED,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    }),
    prisma.backgroundJob.findMany({
      where: { leaseExpiresAt: { lte: now }, status: BackgroundJobStatus.PROCESSING },
      orderBy: { leaseExpiresAt: 'asc' },
      select: { id: true },
    }),
    prisma.knowledgeAttachment.findMany({ select: { id: true, storageKey: true } }),
    prisma.documentProcessingJob.findMany({
      where: { extraction: null, status: DocumentProcessingJobStatus.SUCCEEDED },
      select: { id: true },
    }),
    prisma.knowledgeChunkingJob.findMany({
      where: { chunkSet: null, status: KnowledgeChunkingJobStatus.SUCCEEDED },
      select: { id: true },
    }),
  ]);

  const attachmentsWithoutBinaries: string[] = [];
  for (const attachment of attachments) {
    try {
      await storage.getObject(attachment.storageKey);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        attachmentsWithoutBinaries.push(attachment.id);
        continue;
      }
      throw error;
    }
  }
  const metadataKeys = new Set(attachments.map((attachment) => attachment.storageKey));
  // GCS runtime identities intentionally receive no object-list permission.
  // Orphan-object enumeration remains a local-development reconciliation aid.
  const localKeys = localStorageRoot ? await listLocalStorageKeys(localStorageRoot) : [];

  return {
    attachmentsWithoutBinaries,
    binariesWithoutMetadata: localKeys.filter((key) => !metadataKeys.has(key)),
    expiredProcessingLeases: expired.map((job) => job.id),
    incompleteChunkSets: chunkingJobs.map((job) => job.id),
    incompleteExtractions: extractionJobs.map((job) => job.id),
    queuedNeverStarted: queued.map((job) => job.id),
  };
}
