import type { AiConversationDependencies } from '../../../database/ai/ai-conversations';
import { createDefaultLanguageModelProviderRegistry } from '../../../services/ai/language-model-provider';

import { knowledgeRetrievalDependencies } from '@/lib/knowledge-retrieval';

export const languageModelProviders = createDefaultLanguageModelProviderRegistry();

export const aiConversationDependencies: AiConversationDependencies = {
  providers: languageModelProviders,
  retrieval: knowledgeRetrievalDependencies,
};
