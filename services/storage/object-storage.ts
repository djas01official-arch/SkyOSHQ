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
