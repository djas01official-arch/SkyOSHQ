import { IdempotencyStrategy, Storage } from '@google-cloud/storage';

import {
  getStorageKeySegments,
  getStorageGeneration,
  type ListObjectsInput,
  type ObjectGenerationOptions,
  type ObjectStorage,
  type ObjectStorageListPage,
  type ObjectStorageMetadata,
  type PutObjectInput,
  StorageObjectAlreadyExistsError,
  StorageObjectGenerationMismatchError,
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
  getMetadata(): Promise<
    [
      Readonly<{
        contentType?: string;
        crc32c?: string;
        etag?: string;
        generation?: string | number;
        size?: string | number;
      }>,
      unknown,
    ]
  >;
  name?: string;
  metadata?: Readonly<{
    contentType?: string;
    crc32c?: string;
    etag?: string;
    generation?: string | number;
    size?: string | number;
  }>;
  save(
    data: Uint8Array,
    options: Readonly<{
      metadata?: Readonly<{ contentType: string }>;
      preconditionOpts: Readonly<{ ifGenerationMatch: 0 }>;
      resumable: false;
      timeout: number;
      validation: 'crc32c';
    }>,
  ): Promise<void>;
}>;

export type GcsBucket = Readonly<{
  file(key: string, options?: Readonly<{ generation?: string }>): GcsFile;
  getFiles(
    options: Readonly<{
      autoPaginate: false;
      maxResults: number;
      pageToken?: string;
      prefix?: string;
    }>,
  ): Promise<[readonly GcsFile[], Readonly<{ pageToken?: string }> | null, unknown]>;
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

function toMetadata(
  metadata: Readonly<{
    contentType?: string;
    crc32c?: string;
    etag?: string;
    generation?: string | number;
    size?: string | number;
  }>,
): ObjectStorageMetadata {
  const size = String(metadata.size ?? '');
  if (!/^\d+$/u.test(size)) throw new Error('GCS returned invalid object size metadata.');
  const generation = String(metadata.generation ?? '');
  if (!/^[1-9]\d*$/u.test(generation)) {
    throw new Error('GCS returned invalid object generation metadata.');
  }
  return {
    contentType: metadata.contentType ?? null,
    crc32c: metadata.crc32c ?? null,
    etag: metadata.etag ?? null,
    generation,
    sizeBytes: BigInt(size),
  };
}

function createDefaultGcsStorageClient(): GcsStorageClient {
  // Storage resolves Application Default Credentials at request time. Do not
  // configure key files, inline credentials, or a service-account identity.
  return new Storage({ retryOptions: GCS_OBJECT_STORAGE_RETRY_OPTIONS });
}

/**
 * Private Google Cloud Storage adapter. It exposes no public ACL, URL, or
 * bucket-management operations. Listing is bounded and paginated for trusted
 * reconciliation; SkyOS remains the download authorization boundary.
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

  async putObject({ contentType, data, key }: PutObjectInput): Promise<ObjectStorageMetadata> {
    getStorageKeySegments(key);
    const file = this.#bucket.file(key);

    try {
      await file.save(data, {
        ...(contentType ? { metadata: { contentType } } : {}),
        preconditionOpts: { ifGenerationMatch: 0 },
        resumable: false,
        timeout: GCS_OBJECT_STORAGE_TIMEOUT_MS,
        validation: 'crc32c',
      });
      const [metadata] = await file.getMetadata();
      return toMetadata(metadata);
    } catch (error) {
      if (isGenerationPreconditionFailure(error)) {
        throw new StorageObjectAlreadyExistsError('The generated storage key already exists.', {
          cause: error,
        });
      }
      throw error;
    }
  }

  async getObject(key: string, options: ObjectGenerationOptions = {}): Promise<Uint8Array> {
    getStorageKeySegments(key);
    const generation = getStorageGeneration(options.generation);

    try {
      const [data] = await this.#bucket.file(key, { generation }).download();
      return new Uint8Array(data);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new StorageObjectNotFoundError('The stored object does not exist.', { cause: error });
      }
      throw error;
    }
  }

  async getObjectMetadata(
    key: string,
    options: ObjectGenerationOptions = {},
  ): Promise<ObjectStorageMetadata> {
    getStorageKeySegments(key);
    const generation = getStorageGeneration(options.generation);
    try {
      const [metadata] = await this.#bucket.file(key, { generation }).getMetadata();
      return toMetadata(metadata);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new StorageObjectNotFoundError('The stored object does not exist.', { cause: error });
      }
      throw error;
    }
  }

  async deleteObject(key: string, options: ObjectGenerationOptions = {}): Promise<void> {
    getStorageKeySegments(key);
    const generation = getStorageGeneration(options.generation);

    try {
      await this.#bucket.file(key, { generation }).delete();
    } catch (error) {
      if (isNotFoundError(error)) return;
      if (isGenerationPreconditionFailure(error)) {
        throw new StorageObjectGenerationMismatchError(
          'The stored object generation changed before deletion.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  async listObjects(input: ListObjectsInput): Promise<ObjectStorageListPage> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000) {
      throw new Error('Object list page size must be between 1 and 1000.');
    }
    if (input.prefix) getStorageKeySegments(input.prefix.replace(/\/$/u, ''));
    const [files, nextQuery] = await this.#bucket.getFiles({
      autoPaginate: false,
      maxResults: input.pageSize,
      pageToken: input.pageToken,
      prefix: input.prefix,
    });
    return {
      items: files.map((file) => ({
        key: file.name ?? '',
        metadata: toMetadata(file.metadata ?? {}),
      })),
      nextPageToken: nextQuery?.pageToken ?? null,
    };
  }
}
