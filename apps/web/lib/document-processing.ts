import {
  executeDocumentProcessingJob,
  type DocumentProcessingRequestDependencies,
  type DocumentProcessingWorkerDependencies,
} from '../../../database/knowledge/document-processing';
import { createDefaultDocumentParserRegistry } from '../../../services/document-processing/document-parser';
import { SynchronousDocumentProcessingQueue } from '../../../services/document-processing/processing-queue';

import { knowledgeAttachmentDependencies } from '@/lib/knowledge-storage';
import { prisma } from '@/lib/prisma';

const parsers = createDefaultDocumentParserRegistry();

export const documentProcessingWorkerDependencies: DocumentProcessingWorkerDependencies = {
  parsers,
  storage: knowledgeAttachmentDependencies.storage,
};

const queue = new SynchronousDocumentProcessingQueue(async (jobId) => {
  await executeDocumentProcessingJob(prisma, documentProcessingWorkerDependencies, jobId);
});

export const documentProcessingRequestDependencies: DocumentProcessingRequestDependencies = {
  parsers,
  queue,
};
