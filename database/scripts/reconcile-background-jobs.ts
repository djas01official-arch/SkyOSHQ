import 'dotenv/config';

import { recoverDomainJobAfterExpiredLease } from '../background-jobs/domain-handlers';
import { createBackgroundJobReconciliationReport } from '../background-jobs/reconciliation';
import { summarizeBackgroundJobReconciliation } from '../background-jobs/reconciliation-observability';
import { repairKnowledgeLifecycleDrift } from '../background-jobs/knowledge-reconciliation';
import { recoverExpiredBackgroundJobs } from '../background-jobs/runtime';
import { PrismaClient } from '../generated/client/client';
import { createPrismaPgAdapter } from '../operations/database-pool';
import { createKnowledgeObjectStorage } from '../../services/storage/knowledge-object-storage';
import { createDefaultDocumentParserRegistry } from '../../services/document-processing/document-parser';
import { createDefaultEmbeddingProviderRegistry } from '../../services/embeddings/embedding-provider';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';
import { createSkyOsLogger, safeErrorTelemetry } from '../../services/observability/logger';

const observabilityLogger = createSkyOsLogger('reconciliation');
const startedAt = Date.now();

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for reconciliation.');
  const repairExpiredLeases = process.argv.slice(2).includes('--repair-expired-leases');
  const repairKnowledgePipeline = process.argv.slice(2).includes('--repair-knowledge-pipeline');
  const unknownOptions = process.argv
    .slice(2)
    .filter(
      (option) => option !== '--repair-expired-leases' && option !== '--repair-knowledge-pipeline',
    );
  if (unknownOptions.length > 0) throw new Error(`Unknown option: ${unknownOptions[0]}`);
  const knowledgeStorage = createKnowledgeObjectStorage({
    runtime: process.env.NODE_ENV ?? 'development',
  });
  const prisma = new PrismaClient({ adapter: createPrismaPgAdapter(connectionString) });
  let repairAttemptedCount = 0;
  let repairSucceededCount = 0;
  let repairFailedCount = 0;

  observabilityLogger.notice({ operation: 'reconciliation.run_started', status: 'RUNNING' });

  try {
    let report = await createBackgroundJobReconciliationReport(
      prisma,
      knowledgeStorage.storage,
      knowledgeStorage.configuration.localRoot ?? undefined,
    );
    if (repairKnowledgePipeline) {
      const result = await repairKnowledgeLifecycleDrift(
        prisma,
        {
          parsers: createDefaultDocumentParserRegistry(),
          providers: createDefaultEmbeddingProviderRegistry(),
          strategies: createDefaultKnowledgeChunkingStrategyRegistry(),
        },
        report,
      );
      repairSucceededCount +=
        result.processingRequested + result.chunkingRequested + result.embeddingRequested;
      repairFailedCount += result.failures.length;
      repairAttemptedCount += repairSucceededCount + repairFailedCount;
      report = await createBackgroundJobReconciliationReport(
        prisma,
        knowledgeStorage.storage,
        knowledgeStorage.configuration.localRoot ?? undefined,
      );
    }
    if (repairExpiredLeases) {
      const result = await recoverExpiredBackgroundJobs(
        prisma,
        100,
        recoverDomainJobAfterExpiredLease,
      );
      repairAttemptedCount += result.recovered + result.failed;
      repairSucceededCount += result.recovered;
      repairFailedCount += result.failed;
    }
    const summary = summarizeBackgroundJobReconciliation(report);
    const fields = {
      operation: 'reconciliation.run_terminal',
      status: 'SUCCEEDED',
      duration_ms: Date.now() - startedAt,
      drift_count: summary.driftCount,
      failed_count: summary.failedBackgroundJobCount,
      repair_attempted_count: repairAttemptedCount,
      repair_succeeded_count: repairSucceededCount,
      repair_failed_count: repairFailedCount,
    } as const;
    if (summary.driftCount > 0 || repairFailedCount > 0) observabilityLogger.warning(fields);
    else observabilityLogger.info(fields);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  observabilityLogger.critical({
    operation: 'reconciliation.run_terminal',
    status: 'FAILED',
    duration_ms: Date.now() - startedAt,
    ...safeErrorTelemetry(error),
  });
  process.exitCode = 1;
});
