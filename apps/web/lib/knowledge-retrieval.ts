import type { KnowledgeRetrievalDependencies } from '../../../database/ai/knowledge-retrieval';

import { knowledgeSearchDependencies } from '@/lib/knowledge-search';

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const knowledgeRetrievalDependencies: KnowledgeRetrievalDependencies = {
  maxResults: optionalPositiveInteger(process.env.KNOWLEDGE_RETRIEVAL_MAX_RESULTS),
  neighborRadius: optionalPositiveInteger(process.env.KNOWLEDGE_RETRIEVAL_NEIGHBOR_RADIUS),
  perSourceCharacterBudget: optionalPositiveInteger(
    process.env.KNOWLEDGE_RETRIEVAL_PER_SOURCE_CHARACTERS,
  ),
  searchDependencies: knowledgeSearchDependencies,
  totalCharacterBudget: optionalPositiveInteger(process.env.KNOWLEDGE_RETRIEVAL_TOTAL_CHARACTERS),
};
