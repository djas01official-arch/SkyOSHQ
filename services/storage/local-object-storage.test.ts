import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LocalObjectStorage } from './local-object-storage';
import { getStorageKeySegments, StorageKeyError } from './object-storage';

test('shared storage-key validation rejects empty, traversal, backslash, and malformed segments', () => {
  for (const key of [
    '',
    '.',
    '..',
    '../outside',
    'workspace/../attachment',
    'workspace//attachment',
    'workspace\\attachment',
    'workspace/attachment:name',
  ]) {
    assert.throws(() => getStorageKeySegments(key), StorageKeyError);
  }
  assert.deepEqual(getStorageKeySegments('workspace-id/document-id/attachment-id.pdf'), [
    'workspace-id',
    'document-id',
    'attachment-id.pdf',
  ]);
});

test('local storage uses the shared safe storage-key validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skyos-local-storage-test-'));
  try {
    const storage = new LocalObjectStorage(root);
    await rm(root, { recursive: true });
    assert.deepEqual(await storage.listObjects({ pageSize: 1 }), {
      items: [],
      nextPageToken: null,
    });
    assert.deepEqual(
      await storage.putObject({
        data: Uint8Array.from([9, 8, 7]),
        key: 'workspace-id/document-id/attachment-id.pdf',
      }),
      { contentType: null, crc32c: null, etag: null, generation: null, sizeBytes: 3n },
    );
    assert.deepEqual(
      Array.from(await storage.getObject('workspace-id/document-id/attachment-id.pdf')),
      [9, 8, 7],
    );
    assert.deepEqual(
      await storage.getObjectMetadata('workspace-id/document-id/attachment-id.pdf'),
      { contentType: null, crc32c: null, etag: null, generation: null, sizeBytes: 3n },
    );
    assert.deepEqual(await storage.listObjects({ pageSize: 1 }), {
      items: [
        {
          key: 'workspace-id/document-id/attachment-id.pdf',
          metadata: {
            contentType: null,
            crc32c: null,
            etag: null,
            generation: null,
            sizeBytes: 3n,
          },
        },
      ],
      nextPageToken: null,
    });
    await assert.rejects(storage.putObject({ data: Uint8Array.of(1), key: 'workspace\\bad.pdf' }));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
