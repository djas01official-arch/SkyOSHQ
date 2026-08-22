import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GCS_OBJECT_STORAGE_TIMEOUT_MS,
  GcsObjectStorage,
  type GcsStorageClient,
} from './gcs-object-storage';
import {
  StorageKeyError,
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
} from './object-storage';

type Operation = 'delete' | 'download' | 'save';

function gcsError(code: number): Error & { code: number } {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function createClient(behavior: Partial<Record<Operation, () => Promise<unknown>>> = {}): {
  client: GcsStorageClient;
  calls: Array<{ data?: Uint8Array; key: string; operation: Operation; options?: unknown }>;
} {
  const calls: Array<{ data?: Uint8Array; key: string; operation: Operation; options?: unknown }> =
    [];
  return {
    calls,
    client: {
      bucket(bucketName) {
        assert.equal(bucketName, 'skyos-private');
        return {
          file(key) {
            return {
              async delete() {
                calls.push({ key, operation: 'delete' });
                await behavior.delete?.();
              },
              async download() {
                calls.push({ key, operation: 'download' });
                const result = await behavior.download?.();
                return [Buffer.from((result as Uint8Array | undefined) ?? 'stored bytes')];
              },
              async save(data, options) {
                calls.push({ data, key, operation: 'save', options });
                await behavior.save?.();
              },
            };
          },
        };
      },
    },
  };
}

test('GCS put writes exact bytes with an atomic create-only generation precondition', async () => {
  const { calls, client } = createClient();
  const storage = new GcsObjectStorage({ bucketName: 'skyos-private', client });
  const bytes = Uint8Array.from([0, 1, 2, 255]);

  await storage.putObject({ data: bytes, key: 'workspace/document/attachment.pdf' });

  assert.deepEqual(calls, [
    {
      data: bytes,
      key: 'workspace/document/attachment.pdf',
      operation: 'save',
      options: {
        preconditionOpts: { ifGenerationMatch: 0 },
        resumable: false,
        timeout: GCS_OBJECT_STORAGE_TIMEOUT_MS,
        validation: 'crc32c',
      },
    },
  ]);
});

test('GCS put maps only generation precondition failures to duplicate objects', async () => {
  const duplicate = createClient({ save: async () => Promise.reject(gcsError(412)) });
  await assert.rejects(
    new GcsObjectStorage({ bucketName: 'skyos-private', client: duplicate.client }).putObject({
      data: Uint8Array.of(1),
      key: 'workspace/document/attachment.pdf',
    }),
    StorageObjectAlreadyExistsError,
  );

  const unexpectedError = gcsError(403);
  const unexpected = createClient({ save: async () => Promise.reject(unexpectedError) });
  await assert.rejects(
    new GcsObjectStorage({ bucketName: 'skyos-private', client: unexpected.client }).putObject({
      data: Uint8Array.of(1),
      key: 'workspace/document/attachment.pdf',
    }),
    (error: unknown) => error === unexpectedError,
  );
});

test('GCS get returns exact bytes and maps only missing objects to not found', async () => {
  const success = createClient({ download: async () => Uint8Array.from([3, 2, 1]) });
  const storage = new GcsObjectStorage({ bucketName: 'skyos-private', client: success.client });
  assert.deepEqual(
    await storage.getObject('workspace/document/attachment.pdf'),
    Uint8Array.from([3, 2, 1]),
  );

  const missing = createClient({ download: async () => Promise.reject(gcsError(404)) });
  await assert.rejects(
    new GcsObjectStorage({ bucketName: 'skyos-private', client: missing.client }).getObject(
      'workspace/document/attachment.pdf',
    ),
    StorageObjectNotFoundError,
  );

  const unexpectedError = gcsError(401);
  const unexpected = createClient({ download: async () => Promise.reject(unexpectedError) });
  await assert.rejects(
    new GcsObjectStorage({ bucketName: 'skyos-private', client: unexpected.client }).getObject(
      'workspace/document/attachment.pdf',
    ),
    (error: unknown) => error === unexpectedError,
  );
});

test('GCS delete is idempotent only for missing objects', async () => {
  const success = createClient();
  await new GcsObjectStorage({ bucketName: 'skyos-private', client: success.client }).deleteObject(
    'workspace/document/attachment.pdf',
  );

  const missing = createClient({ delete: async () => Promise.reject(gcsError(404)) });
  await new GcsObjectStorage({ bucketName: 'skyos-private', client: missing.client }).deleteObject(
    'workspace/document/attachment.pdf',
  );

  const unexpectedError = gcsError(403);
  const unexpected = createClient({ delete: async () => Promise.reject(unexpectedError) });
  await assert.rejects(
    new GcsObjectStorage({ bucketName: 'skyos-private', client: unexpected.client }).deleteObject(
      'workspace/document/attachment.pdf',
    ),
    (error: unknown) => error === unexpectedError,
  );
});

test('GCS uses the same logical key contract as local storage', async () => {
  const { client } = createClient();
  const storage = new GcsObjectStorage({ bucketName: 'skyos-private', client });
  for (const key of [
    '',
    '../outside',
    'workspace/../attachment',
    'workspace\\attachment',
    '/root',
  ]) {
    await assert.rejects(storage.getObject(key), StorageKeyError);
  }

  await storage.getObject('workspace-id/document-id/attachment-id.pdf');
});
