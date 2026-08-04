import { isAbsolute, resolve } from 'node:path';

import { LocalObjectStorage } from '../../../services/storage/local-object-storage';
import { getKnowledgeMaxFileSizeBytes } from '../../../services/storage/storage-config';

const configuredRoot = process.env.KNOWLEDGE_STORAGE_ROOT?.trim() || '.skyos/knowledge';
const storageRoot = isAbsolute(configuredRoot)
  ? configuredRoot
  : resolve(/* turbopackIgnore: true */ process.cwd(), '../..', configuredRoot);

export const knowledgeAttachmentDependencies = {
  maxFileSizeBytes: getKnowledgeMaxFileSizeBytes(),
  storage: new LocalObjectStorage(storageRoot),
} as const;
