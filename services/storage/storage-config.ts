export const DEFAULT_KNOWLEDGE_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_KNOWLEDGE_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export function getKnowledgeMaxFileSizeBytes(
  value = process.env.KNOWLEDGE_MAX_FILE_SIZE_BYTES,
): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_KNOWLEDGE_MAX_FILE_SIZE_BYTES;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error('KNOWLEDGE_MAX_FILE_SIZE_BYTES must be a positive integer.');
  }

  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_KNOWLEDGE_FILE_SIZE_BYTES) {
    throw new Error(
      `KNOWLEDGE_MAX_FILE_SIZE_BYTES must be between 1 and ${MAX_KNOWLEDGE_FILE_SIZE_BYTES}.`,
    );
  }

  return size;
}
