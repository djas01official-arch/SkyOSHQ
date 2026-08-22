import { resolve } from 'node:path';

import { createKnowledgeObjectStorage } from '../../../services/storage/knowledge-object-storage';
import { getKnowledgeMaxFileSizeBytes } from '../../../services/storage/storage-config';

const repositoryRoot = resolve(/* turbopackIgnore: true */ process.cwd(), '../..');

/** Defers production storage validation/client construction until a request needs it. */
export function getKnowledgeAttachmentDependencies() {
  return {
    maxFileSizeBytes: getKnowledgeMaxFileSizeBytes(),
    storage: createKnowledgeObjectStorage({ localRootBaseDirectory: repositoryRoot }).storage,
  } as const;
}
