import type { KnowledgeSearchDependencies } from '../../../database/knowledge/knowledge-search';

import { createDefaultEmbeddingProviderRegistry } from '../../../services/embeddings/embedding-provider';

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const embeddingProviders = createDefaultEmbeddingProviderRegistry();

export const knowledgeSearchDependencies: KnowledgeSearchDependencies = {
  maxResults: optionalPositiveInteger(process.env.KNOWLEDGE_SEARCH_MAX_RESULTS),
  perSourceLimit: optionalPositiveInteger(process.env.KNOWLEDGE_SEARCH_PER_SOURCE_LIMIT),
  providers: embeddingProviders,
  timeoutMs: optionalPositiveInteger(process.env.KNOWLEDGE_SEARCH_TIMEOUT_MS),
};
