export type PutObjectInput = Readonly<{
  contentType?: string;
  data: Uint8Array;
  key: string;
}>;

export type ObjectStorageMetadata = Readonly<{
  contentType: string | null;
  crc32c: string | null;
  etag: string | null;
  generation: string | null;
  sizeBytes: bigint;
}>;

export type ObjectGenerationOptions = Readonly<{
  generation?: string | null;
}>;

export type ListObjectsInput = Readonly<{
  pageSize: number;
  pageToken?: string;
  prefix?: string;
}>;

export type ObjectStorageListPage = Readonly<{
  items: readonly Readonly<{ key: string; metadata: ObjectStorageMetadata }>[];
  nextPageToken: string | null;
}>;

/** Minimal key-based storage port suitable for local disk or a future S3 adapter. */
export interface ObjectStorage {
  deleteObject(key: string, options?: ObjectGenerationOptions): Promise<void>;
  getObject(key: string, options?: ObjectGenerationOptions): Promise<Uint8Array>;
  getObjectMetadata?(
    key: string,
    options?: ObjectGenerationOptions,
  ): Promise<ObjectStorageMetadata>;
  listObjects?(input: ListObjectsInput): Promise<ObjectStorageListPage>;
  putObject(input: PutObjectInput): Promise<ObjectStorageMetadata | void>;
}

export class StorageError extends Error {}

export class StorageKeyError extends StorageError {}

export class StorageObjectAlreadyExistsError extends StorageError {}

export class StorageObjectNotFoundError extends StorageError {}

export class StorageObjectGenerationMismatchError extends StorageError {}

const MAX_STORAGE_KEY_LENGTH = 1024;
const STORAGE_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STORAGE_GENERATION_PATTERN = /^[1-9][0-9]*$/;

/**
 * Validates the opaque, server-generated storage key contract shared by every
 * ObjectStorage adapter. Object keys are logical paths, never client paths.
 */
export function getStorageKeySegments(key: string): string[] {
  if (
    key.length < 1 ||
    key.length > MAX_STORAGE_KEY_LENGTH ||
    key.startsWith('/') ||
    key.includes('\\')
  ) {
    throw new StorageKeyError('The object key is not a safe relative storage key.');
  }

  const segments = key.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !STORAGE_KEY_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new StorageKeyError('The object key contains an unsafe path segment.');
  }

  return segments;
}

export function getStorageGeneration(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!STORAGE_GENERATION_PATTERN.test(value)) {
    throw new StorageKeyError('The object generation is invalid.');
  }
  return value;
}
