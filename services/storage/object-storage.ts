export type PutObjectInput = Readonly<{
  data: Uint8Array;
  key: string;
}>;

/** Minimal key-based storage port suitable for local disk or a future S3 adapter. */
export interface ObjectStorage {
  deleteObject(key: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  putObject(input: PutObjectInput): Promise<void>;
}

export class StorageError extends Error {}

export class StorageKeyError extends StorageError {}

export class StorageObjectAlreadyExistsError extends StorageError {}

export class StorageObjectNotFoundError extends StorageError {}

const MAX_STORAGE_KEY_LENGTH = 1024;
const STORAGE_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
