import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  getStorageKeySegments,
  type ObjectStorage,
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

  async putObject({ data, key }: PutObjectInput): Promise<void> {
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
  }

  async getObject(key: string): Promise<Uint8Array> {
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

  async deleteObject(key: string): Promise<void> {
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
}
