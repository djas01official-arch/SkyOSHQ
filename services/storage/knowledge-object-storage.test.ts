import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { GcsObjectStorage } from './gcs-object-storage';
import {
  createKnowledgeObjectStorage,
  KnowledgeStorageConfigurationError,
  parseKnowledgeStorageConfiguration,
} from './knowledge-object-storage';
import { LocalObjectStorage } from './local-object-storage';

const localEnvironment = { KNOWLEDGE_STORAGE_ROOT: '.skyos/knowledge' } as const;
const gcsEnvironment = {
  KNOWLEDGE_GCS_BUCKET: 'skyos-private-attachments',
  KNOWLEDGE_STORAGE_PROVIDER: 'gcs',
} as const;

test('development defaults to local storage and preserves an explicit local selection', () => {
  const implicit = createKnowledgeObjectStorage({
    environment: {},
    localRootBaseDirectory: '/repository',
    runtime: 'development',
  });
  const explicit = createKnowledgeObjectStorage({
    environment: { ...localEnvironment, KNOWLEDGE_STORAGE_PROVIDER: 'local' },
    localRootBaseDirectory: '/repository',
    runtime: 'development',
  });

  assert.ok(implicit.storage instanceof LocalObjectStorage);
  assert.ok(explicit.storage instanceof LocalObjectStorage);
  assert.match(implicit.configuration.localRoot, /[\\/]repository[\\/]\.skyos[\\/]knowledge$/);
  assert.equal(explicit.configuration.provider, 'local');
});

test('development and test can explicitly select configured GCS without a cloud request', () => {
  const calls: string[] = [];
  for (const runtime of ['development', 'test'] as const) {
    const result = createKnowledgeObjectStorage({
      createGcsStorage: ({ bucketName }) => {
        calls.push(bucketName);
        return {
          deleteObject: async () => {},
          getObject: async () => Uint8Array.of(),
          putObject: async () => {},
        };
      },
      environment: gcsEnvironment,
      runtime,
    });
    assert.equal(result.configuration.provider, 'gcs');
    assert.equal(result.configuration.bucketName, 'skyos-private-attachments');
  }
  assert.deepEqual(calls, ['skyos-private-attachments', 'skyos-private-attachments']);
});

test('production permits only configured GCS and never constructs local storage', () => {
  const result = createKnowledgeObjectStorage({
    environment: gcsEnvironment,
    runtime: 'production',
  });
  assert.ok(result.storage instanceof GcsObjectStorage);
  assert.equal(result.configuration.provider, 'gcs');

  for (const environment of [
    {},
    { KNOWLEDGE_STORAGE_PROVIDER: 'local' },
    { KNOWLEDGE_STORAGE_PROVIDER: 'unknown' },
    { KNOWLEDGE_STORAGE_PROVIDER: 'gcs' },
  ]) {
    assert.throws(
      () => createKnowledgeObjectStorage({ environment, runtime: 'production' }),
      KnowledgeStorageConfigurationError,
    );
  }
});

test('unknown runtimes never gain an implicit local-storage fallback', () => {
  for (const runtime of [undefined, 'preview', 'Production']) {
    assert.throws(
      () => parseKnowledgeStorageConfiguration({}, runtime, '/repository'),
      KnowledgeStorageConfigurationError,
    );
  }
});

test('storage configuration rejects unknown providers and incomplete explicit GCS configuration', () => {
  for (const [environment, runtime] of [
    [{ KNOWLEDGE_STORAGE_PROVIDER: 's3' }, 'development'],
    [{ KNOWLEDGE_STORAGE_PROVIDER: 'gcs' }, 'development'],
    [{ KNOWLEDGE_STORAGE_PROVIDER: 'gcs', KNOWLEDGE_GCS_BUCKET: '  ' }, 'test'],
  ] as const) {
    assert.throws(
      () => parseKnowledgeStorageConfiguration(environment, runtime),
      KnowledgeStorageConfigurationError,
    );
  }
});

test('web, worker, and reconciliation select storage through the shared factory', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../..');
  for (const relativePath of [
    'apps/web/lib/knowledge-storage.ts',
    'database/scripts/background-worker.ts',
    'database/scripts/reconcile-background-jobs.ts',
  ]) {
    const source = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
    assert.match(source, /createKnowledgeObjectStorage/);
    assert.doesNotMatch(source, /new LocalObjectStorage|KNOWLEDGE_STORAGE_ROOT/);
  }
});
