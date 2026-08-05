import { executeDurableDomainJobByReference } from '../../../database/background-jobs/domain-handlers';
import { BackgroundJobKind } from '../../../database/generated/client/client';
import type { KnowledgeEmbeddingRequestDependencies } from '../../../database/knowledge/knowledge-embeddings';
import {
  getBackgroundJobMode,
  PostgresBackgroundJobQueue,
  SynchronousBackgroundJobQueue,
} from '../../../services/document-processing/processing-queue';

import {
  domainBackgroundJobDependencies,
  embeddingProviders,
} from '@/lib/background-job-dependencies';
import { prisma } from '@/lib/prisma';

const queue =
  getBackgroundJobMode() === 'durable'
    ? new PostgresBackgroundJobQueue()
    : new SynchronousBackgroundJobQueue(async (domainJobId) => {
        await executeDurableDomainJobByReference(
          prisma,
          domainBackgroundJobDependencies,
          BackgroundJobKind.KNOWLEDGE_EMBEDDING,
          domainJobId,
          `web-sync-${process.pid}`,
        );
      });

export const knowledgeEmbeddingRequestDependencies: KnowledgeEmbeddingRequestDependencies = {
  providers: embeddingProviders,
  queue,
};
