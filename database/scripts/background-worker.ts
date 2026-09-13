import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  createSkyOsBackgroundJobHandler,
  recoverSkyOsJobAfterExpiredLease,
} from '../background-jobs/skyos-handlers';
import { createAiRuntimeDependencies } from '../ai/ai-runtime-dependencies';
import { PrismaClient } from '../generated/client/client';
import { assertPgvectorAvailable } from '../knowledge/vector-health';
import { createDefaultDocumentParserRegistry } from '../../services/document-processing/document-parser';
import { getBackgroundWorkerConfig } from '../../services/background-jobs/config';
import { runBackgroundWorker } from '../../services/background-jobs/worker';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';
import { createDefaultEmbeddingProviderRegistry } from '../../services/embeddings/embedding-provider';
import { createKnowledgeObjectStorage } from '../../services/storage/knowledge-object-storage';
import { createSkyOsLogger, safeErrorTelemetry } from '../../services/observability/logger';

const logger = createSkyOsLogger('worker');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is required to start the background worker.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const controller = new AbortController();
  const requestShutdown = () => controller.abort();
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  const config = getBackgroundWorkerConfig();
  const knowledgeStorage = createKnowledgeObjectStorage({
    // `pnpm worker` is the documented local development command. Production
    // Cloud Run sets NODE_ENV=production in the immutable image.
    runtime: process.env.NODE_ENV ?? 'development',
  });
  const dependencies = {
    ai: createAiRuntimeDependencies(),
    domain: {
      documentProcessing: {
        parsers: createDefaultDocumentParserRegistry(),
        storage: knowledgeStorage.storage,
      },
      knowledgeChunking: {
        strategies: createDefaultKnowledgeChunkingStrategyRegistry(),
      },
      knowledgeEmbedding: {
        providers: createDefaultEmbeddingProviderRegistry(),
      },
    },
  };

  try {
    await assertPgvectorAvailable(prisma);
    logger.notice({ operation: 'worker.lifecycle', status: 'STARTED' });
    await runBackgroundWorker({
      handler: createSkyOsBackgroundJobHandler(prisma, dependencies),
      observabilityIntervalMs: config.observabilityIntervalMs,
      pollIntervalMs: config.pollIntervalMs,
      prisma,
      recoveryHook: recoverSkyOsJobAfterExpiredLease,
      recoveryIntervalMs: config.recoveryIntervalMs,
      runtime: config.runtime,
      signal: controller.signal,
      workerId: config.workerId,
    });
    logger.notice({ operation: 'worker.lifecycle', status: 'STOPPED' });
  } finally {
    process.off('SIGINT', requestShutdown);
    process.off('SIGTERM', requestShutdown);
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  logger.critical({
    operation: 'worker.lifecycle',
    status: 'FAILED',
    ...safeErrorTelemetry(error),
  });
  process.exitCode = 1;
});
