import { IdempotencyStrategy, Storage } from '@google-cloud/storage';

import {
  getStorageKeySegments,
  type ObjectStorage,
  type PutObjectInput,
  StorageObjectAlreadyExistsError,
  StorageObjectNotFoundError,
} from './object-storage';

export const GCS_OBJECT_STORAGE_TIMEOUT_MS = 10_000;

export const GCS_OBJECT_STORAGE_RETRY_OPTIONS = Object.freeze({
  autoRetry: true,
  idempotencyStrategy: IdempotencyStrategy.RetryConditional,
  maxRetries: 2,
  maxRetryDelay: 2_000,
  retryDelayMultiplier: 2,
  totalTimeout: GCS_OBJECT_STORAGE_TIMEOUT_MS,
});

export type GcsFile = Readonly<{
  delete(): Promise<unknown>;
  download(): Promise<[Buffer]>;
  save(
    data: Uint8Array,
    options: Readonly<{
      preconditionOpts: Readonly<{ ifGenerationMatch: 0 }>;
      resumable: false;
      timeout: number;
      validation: 'crc32c';
    }>,
  ): Promise<void>;
}>;

export type GcsBucket = Readonly<{
  file(key: string): GcsFile;
}>;

export type GcsStorageClient = Readonly<{
  bucket(name: string): GcsBucket;
}>;

export type GcsObjectStorageOptions = Readonly<{
  bucketName: string;
  client?: GcsStorageClient;
}>;

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);
  return null;
}

function isNotFoundError(error: unknown): boolean {
  return getStatusCode(error) === 404;
}

function isGenerationPreconditionFailure(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

function createDefaultGcsStorageClient(): GcsStorageClient {
  // Storage resolves Application Default Credentials at request time. Do not
  // configure key files, inline credentials, or a service-account identity.
  return new Storage({ retryOptions: GCS_OBJECT_STORAGE_RETRY_OPTIONS });
}

/**
 * Private Google Cloud Storage adapter. It deliberately exposes no public ACL,
 * URL, bucket-management, or list operations; SkyOS remains the download
 * authorization boundary.
 */
export class GcsObjectStorage implements ObjectStorage {
  readonly #bucket: GcsBucket;

  constructor({ bucketName, client = createDefaultGcsStorageClient() }: GcsObjectStorageOptions) {
    const normalizedBucketName = bucketName.trim();
    if (!normalizedBucketName) {
      throw new Error('A non-blank GCS bucket name is required.');
    }
    this.#bucket = client.bucket(normalizedBucketName);
  }

  async putObject({ data, key }: PutObjectInput): Promise<void> {
    getStorageKeySegments(key);

    try {
      await this.#bucket.file(key).save(data, {
        preconditionOpts: { ifGenerationMatch: 0 },
        resumable: false,
        timeout: GCS_OBJECT_STORAGE_TIMEOUT_MS,
        validation: 'crc32c',
      });
    } catch (error) {
      if (isGenerationPreconditionFailure(error)) {
        throw new StorageObjectAlreadyExistsError('The generated storage key already exists.', {
          cause: error,
        });
      }
      throw error;
    }
  }

  async getObject(key: string): Promise<Uint8Array> {
    getStorageKeySegments(key);

    try {
      const [data] = await this.#bucket.file(key).download();
      return new Uint8Array(data);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new StorageObjectNotFoundError('The stored object does not exist.', { cause: error });
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    getStorageKeySegments(key);

    try {
      await this.#bucket.file(key).delete();
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  }
}
