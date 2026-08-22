import { isAbsolute, resolve } from 'node:path';

import { GcsObjectStorage, type GcsObjectStorageOptions } from './gcs-object-storage';
import { LocalObjectStorage } from './local-object-storage';
import type { ObjectStorage } from './object-storage';

export type KnowledgeStorageRuntime = 'development' | 'production' | 'test';
export type KnowledgeStorageProvider = 'gcs' | 'local';

export type KnowledgeStorageEnvironment = Readonly<Record<string, string | undefined>>;

export type KnowledgeStorageConfiguration =
  | Readonly<{
      localRoot: string;
      provider: 'local';
      runtime: Exclude<KnowledgeStorageRuntime, 'production'>;
    }>
  | Readonly<{
      bucketName: string;
      localRoot: null;
      provider: 'gcs';
      runtime: KnowledgeStorageRuntime;
    }>;

export type KnowledgeObjectStorage = Readonly<{
  configuration: KnowledgeStorageConfiguration;
  storage: ObjectStorage;
}>;

export type CreateKnowledgeObjectStorageOptions = Readonly<{
  createGcsStorage?: (options: GcsObjectStorageOptions) => ObjectStorage;
  environment?: KnowledgeStorageEnvironment;
  localRootBaseDirectory?: string;
  runtime?: unknown;
}>;

export class KnowledgeStorageConfigurationError extends Error {}

function getRuntime(value: unknown): KnowledgeStorageRuntime {
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new KnowledgeStorageConfigurationError(
    'Knowledge storage requires an explicit development, test, or production runtime.',
  );
}

function getProvider(value: string | undefined): KnowledgeStorageProvider | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'local' || normalized === 'gcs') return normalized;
  throw new KnowledgeStorageConfigurationError('KNOWLEDGE_STORAGE_PROVIDER is invalid.');
}

function getLocalRoot(value: string | undefined, baseDirectory: string): string {
  const configuredRoot = value?.trim() || '.skyos/knowledge';
  return isAbsolute(configuredRoot) ? configuredRoot : resolve(baseDirectory, configuredRoot);
}

function getBucketName(value: string | undefined): string {
  const bucketName = value?.trim();
  if (!bucketName) {
    throw new KnowledgeStorageConfigurationError(
      'KNOWLEDGE_GCS_BUCKET is required when KNOWLEDGE_STORAGE_PROVIDER is gcs.',
    );
  }
  return bucketName;
}

/**
 * Parses the complete storage selection matrix without creating clients or
 * touching the filesystem. Unknown runtimes never gain an implicit local disk
 * fallback.
 */
export function parseKnowledgeStorageConfiguration(
  environment: KnowledgeStorageEnvironment = process.env,
  runtime: unknown = process.env.NODE_ENV,
  localRootBaseDirectory = process.cwd(),
): KnowledgeStorageConfiguration {
  const resolvedRuntime = getRuntime(runtime);
  const configuredProvider = getProvider(environment.KNOWLEDGE_STORAGE_PROVIDER);

  if (resolvedRuntime === 'production') {
    if (configuredProvider !== 'gcs') {
      throw new KnowledgeStorageConfigurationError(
        'Production requires KNOWLEDGE_STORAGE_PROVIDER to be exactly gcs.',
      );
    }
    return {
      bucketName: getBucketName(environment.KNOWLEDGE_GCS_BUCKET),
      localRoot: null,
      provider: 'gcs',
      runtime: resolvedRuntime,
    };
  }

  if (configuredProvider === 'gcs') {
    return {
      bucketName: getBucketName(environment.KNOWLEDGE_GCS_BUCKET),
      localRoot: null,
      provider: 'gcs',
      runtime: resolvedRuntime,
    };
  }

  return {
    localRoot: getLocalRoot(environment.KNOWLEDGE_STORAGE_ROOT, localRootBaseDirectory),
    provider: 'local',
    runtime: resolvedRuntime,
  };
}

/**
 * The only normal runtime construction point for Knowledge binary storage.
 * Tests may construct adapters directly; production web/worker/reconciliation
 * paths must use this factory so their provider and namespace cannot diverge.
 */
export function createKnowledgeObjectStorage(
  options: CreateKnowledgeObjectStorageOptions = {},
): KnowledgeObjectStorage {
  const configuration = parseKnowledgeStorageConfiguration(
    options.environment,
    options.runtime,
    options.localRootBaseDirectory,
  );
  if (configuration.provider === 'local') {
    return { configuration, storage: new LocalObjectStorage(configuration.localRoot) };
  }

  return {
    configuration,
    storage: (options.createGcsStorage ?? ((input) => new GcsObjectStorage(input)))({
      bucketName: configuration.bucketName,
    }),
  };
}
