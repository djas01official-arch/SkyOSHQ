import { type KnowledgeChunkingRequestDependencies } from '../../../database/knowledge/knowledge-chunking';
import { BackgroundJobKind } from '../../../database/generated/client/client';
import { executeDurableDomainJobByReference } from '../../../database/background-jobs/domain-handlers';
import {
  getBackgroundJobMode,
  PostgresBackgroundJobQueue,
  SynchronousBackgroundJobQueue,
} from '../../../services/document-processing/processing-queue';

import {
  chunkingStrategies,
  getDomainBackgroundJobDependencies,
} from '@/lib/background-job-dependencies';
import { prisma } from '@/lib/prisma';

const queue =
  getBackgroundJobMode() === 'durable'
    ? new PostgresBackgroundJobQueue()
    : new SynchronousBackgroundJobQueue(async (jobId) => {
        await executeDurableDomainJobByReference(
          prisma,
          getDomainBackgroundJobDependencies(),
          BackgroundJobKind.KNOWLEDGE_CHUNKING,
          jobId,
          `web-sync-${process.pid}`,
        );
      });

export const knowledgeChunkingRequestDependencies: KnowledgeChunkingRequestDependencies = {
  queue,
  strategies: chunkingStrategies,
};
