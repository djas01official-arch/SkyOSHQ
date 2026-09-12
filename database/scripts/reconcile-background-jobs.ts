import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { recoverDomainJobAfterExpiredLease } from '../background-jobs/domain-handlers';
import { createBackgroundJobReconciliationReport } from '../background-jobs/reconciliation';
import { repairKnowledgeLifecycleDrift } from '../background-jobs/knowledge-reconciliation';
import { recoverExpiredBackgroundJobs } from '../background-jobs/runtime';
import { PrismaClient } from '../generated/client/client';
import { createKnowledgeObjectStorage } from '../../services/storage/knowledge-object-storage';
import { createDefaultDocumentParserRegistry } from '../../services/document-processing/document-parser';
import { createDefaultEmbeddingProviderRegistry } from '../../services/embeddings/embedding-provider';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../services/knowledge-chunking/chunking-strategy';

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
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const report = await createBackgroundJobReconciliationReport(
      prisma,
      knowledgeStorage.storage,
      knowledgeStorage.configuration.localRoot ?? undefined,
    );
    console.log(JSON.stringify({ mode: 'report-only', ...report }, null, 2));
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
      console.log(JSON.stringify({ mode: 'repair-knowledge-pipeline', ...result }, null, 2));
      const postRepairReport = await createBackgroundJobReconciliationReport(
        prisma,
        knowledgeStorage.storage,
        knowledgeStorage.configuration.localRoot ?? undefined,
      );
      console.log(JSON.stringify({ mode: 'post-repair-report', ...postRepairReport }, null, 2));
    }
    if (repairExpiredLeases) {
      const result = await recoverExpiredBackgroundJobs(
        prisma,
        100,
        recoverDomainJobAfterExpiredLease,
      );
      console.log(JSON.stringify({ mode: 'repair-expired-leases', ...result }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Background-job reconciliation failed.');
  process.exitCode = 1;
});
