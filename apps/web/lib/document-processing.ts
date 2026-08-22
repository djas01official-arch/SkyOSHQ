import { type DocumentProcessingRequestDependencies } from '../../../database/knowledge/document-processing';
import { BackgroundJobKind } from '../../../database/generated/client/client';
import { executeDurableDomainJobByReference } from '../../../database/background-jobs/domain-handlers';
import {
  getBackgroundJobMode,
  PostgresBackgroundJobQueue,
  SynchronousDocumentProcessingQueue,
} from '../../../services/document-processing/processing-queue';

import {
  documentParsers,
  getDomainBackgroundJobDependencies,
} from '@/lib/background-job-dependencies';
import { prisma } from '@/lib/prisma';

const queue =
  getBackgroundJobMode() === 'durable'
    ? new PostgresBackgroundJobQueue()
    : new SynchronousDocumentProcessingQueue(async (jobId) => {
        await executeDurableDomainJobByReference(
          prisma,
          getDomainBackgroundJobDependencies(),
          BackgroundJobKind.DOCUMENT_EXTRACTION,
          jobId,
          `web-sync-${process.pid}`,
        );
      });

export const documentProcessingRequestDependencies: DocumentProcessingRequestDependencies = {
  parsers: documentParsers,
  queue,
};
