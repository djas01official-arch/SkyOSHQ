import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  getStorageKeySegments,
  getStorageGeneration,
  type ListObjectsInput,
  type ObjectGenerationOptions,
  type ObjectStorage,
  type ObjectStorageListPage,
  type ObjectStorageMetadata,
  type PutObjectInput,
  StorageKeyError,
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
} from './object-storage';

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertWithinRoot(root: string, target: string): void {
  const pathFromRoot = relative(root, target);

  if (
    pathFromRoot === '' ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new StorageKeyError('The object key resolves outside the storage root.');
  }
}

export class LocalObjectStorage implements ObjectStorage {
  readonly #configuredRoot: string;

  constructor(root: string) {
    this.#configuredRoot = resolve(root);
  }

  async #getRoot(): Promise<string> {
    await mkdir(this.#configuredRoot, { recursive: true });
    return realpath(this.#configuredRoot);
  }

  async #getCandidate(key: string): Promise<{ candidate: string; root: string }> {
    const root = await this.#getRoot();
    const candidate = resolve(root, ...getStorageKeySegments(key));
    assertWithinRoot(root, candidate);
    return { candidate, root };
  }

  async putObject({ data, key }: PutObjectInput): Promise<ObjectStorageMetadata> {
    const { candidate, root } = await this.#getCandidate(key);
    const parent = dirname(candidate);
    await mkdir(parent, { recursive: true });
    const canonicalParent = await realpath(parent);
    assertWithinRoot(root, canonicalParent);

    try {
      await writeFile(candidate, data, { flag: 'wx' });
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        throw new StorageObjectAlreadyExistsError('The generated storage key already exists.');
      }
      throw error;
    }
    return {
      contentType: null,
      crc32c: null,
      etag: null,
      generation: null,
      sizeBytes: BigInt(data.byteLength),
    };
  }

  async getObject(key: string, options: ObjectGenerationOptions = {}): Promise<Uint8Array> {
    getStorageGeneration(options.generation);
    const { candidate, root } = await this.#getCandidate(key);

    try {
      const canonicalFile = await realpath(candidate);
      assertWithinRoot(root, canonicalFile);
      return await readFile(canonicalFile);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new StorageObjectNotFoundError('The stored object does not exist.');
      }
      throw error;
    }
  }

  async getObjectMetadata(
    key: string,
    options: ObjectGenerationOptions = {},
  ): Promise<ObjectStorageMetadata> {
    getStorageGeneration(options.generation);
    const { candidate, root } = await this.#getCandidate(key);
    try {
      const canonicalFile = await realpath(candidate);
      assertWithinRoot(root, canonicalFile);
      const value = await stat(canonicalFile);
      return {
        contentType: null,
        crc32c: null,
        etag: null,
        generation: null,
        sizeBytes: BigInt(value.size),
      };
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new StorageObjectNotFoundError('The stored object does not exist.');
      }
      throw error;
    }
  }

  async deleteObject(key: string, options: ObjectGenerationOptions = {}): Promise<void> {
    getStorageGeneration(options.generation);
    const { candidate, root } = await this.#getCandidate(key);

    try {
      const canonicalFile = await realpath(candidate);
      assertWithinRoot(root, canonicalFile);
      await unlink(canonicalFile);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
  }

  async listObjects(input: ListObjectsInput): Promise<ObjectStorageListPage> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000) {
      throw new Error('Object list page size must be between 1 and 1000.');
    }
    const prefix = input.prefix ?? '';
    if (prefix) getStorageKeySegments(prefix.replace(/\/$/u, ''));
    const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('The local object list page token is invalid.');
    }
    const root = await this.#getRoot();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { items: [], nextPageToken: null };
      throw error;
    }
    const keys = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const parent = 'parentPath' in entry ? entry.parentPath : root;
        return relative(root, resolve(parent, entry.name)).split(sep).join('/');
      })
      .filter((key) => key.startsWith(prefix))
      .sort();
    const selected = keys.slice(offset, offset + input.pageSize);
    return {
      items: await Promise.all(
        selected.map(async (key) => ({ key, metadata: await this.getObjectMetadata(key) })),
      ),
      nextPageToken:
        offset + selected.length < keys.length ? String(offset + selected.length) : null,
    };
  }
}
