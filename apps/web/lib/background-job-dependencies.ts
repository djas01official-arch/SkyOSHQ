import type { DomainBackgroundJobDependencies } from '../../../database/background-jobs/domain-handlers';
import { createDefaultDocumentParserRegistry } from '../../../services/document-processing/document-parser';
import { createDefaultKnowledgeChunkingStrategyRegistry } from '../../../services/knowledge-chunking/chunking-strategy';
import { createDefaultEmbeddingProviderRegistry } from '../../../services/embeddings/embedding-provider';

import { knowledgeAttachmentDependencies } from '@/lib/knowledge-storage';

export const documentParsers = createDefaultDocumentParserRegistry();
export const chunkingStrategies = createDefaultKnowledgeChunkingStrategyRegistry();
export const embeddingProviders = createDefaultEmbeddingProviderRegistry();

export const domainBackgroundJobDependencies: DomainBackgroundJobDependencies = {
  documentProcessing: {
    parsers: documentParsers,
    storage: knowledgeAttachmentDependencies.storage,
  },
  knowledgeChunking: {
    strategies: chunkingStrategies,
  },
  knowledgeEmbedding: {
    providers: embeddingProviders,
  },
};
