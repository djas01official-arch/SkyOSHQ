import type { AiConversationDependencies } from './ai-conversations';
import type { KnowledgeRetrievalDependencies } from './knowledge-retrieval';
import type { KnowledgeSearchDependencies } from '../knowledge/knowledge-search';
import { createDefaultLanguageModelProviderRegistry } from '../../services/ai/language-model-provider';
import { createDefaultEmbeddingProviderRegistry } from '../../services/embeddings/embedding-provider';

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function createAiRuntimeDependencies(): AiConversationDependencies {
  const searchDependencies: KnowledgeSearchDependencies = {
    maxResults: optionalPositiveInteger(process.env.KNOWLEDGE_SEARCH_MAX_RESULTS),
    perSourceLimit: optionalPositiveInteger(process.env.KNOWLEDGE_SEARCH_PER_SOURCE_LIMIT),
    get providers() {
      return createDefaultEmbeddingProviderRegistry();
    },
    timeoutMs: optionalPositiveInteger(process.env.KNOWLEDGE_SEARCH_TIMEOUT_MS),
  };
  const retrieval: KnowledgeRetrievalDependencies = {
    maxResults: optionalPositiveInteger(process.env.KNOWLEDGE_RETRIEVAL_MAX_RESULTS),
    neighborRadius: optionalPositiveInteger(process.env.KNOWLEDGE_RETRIEVAL_NEIGHBOR_RADIUS),
    perSourceCharacterBudget: optionalPositiveInteger(
      process.env.KNOWLEDGE_RETRIEVAL_PER_SOURCE_CHARACTERS,
    ),
    searchDependencies,
    totalCharacterBudget: optionalPositiveInteger(process.env.KNOWLEDGE_RETRIEVAL_TOTAL_CHARACTERS),
  };
  return Object.freeze({
    providers: createDefaultLanguageModelProviderRegistry(),
    retrieval,
  });
}
