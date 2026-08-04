import {
  executeKnowledgeChunkingJob,
  type KnowledgeChunkingRequestDependencies,
  type KnowledgeChunkingWorkerDependencies,
} from '../../../database/knowledge/knowledge-chunking';
import { SynchronousBackgroundJobQueue } from '../../../services/document-processing/processing-queue';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../../services/knowledge-chunking/chunking-strategy';

import { prisma } from '@/lib/prisma';

const strategies = createDefaultKnowledgeChunkingStrategyRegistry();

export const knowledgeChunkingWorkerDependencies: KnowledgeChunkingWorkerDependencies = {
  strategies,
};

const queue = new SynchronousBackgroundJobQueue(async (jobId) => {
  await executeKnowledgeChunkingJob(prisma, knowledgeChunkingWorkerDependencies, jobId);
});

export const knowledgeChunkingRequestDependencies: KnowledgeChunkingRequestDependencies = {
  queue,
  strategies,
};
