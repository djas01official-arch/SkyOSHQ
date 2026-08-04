import { createHash } from 'node:crypto';

export type KnowledgeChunkDraft = Readonly<{
  ordinal: number;
  text: string;
  characterStart: number;
  characterEnd: number;
  tokenEstimate: number;
  sha256: string;
  metadata: Readonly<Record<string, string | number>>;
}>;

export interface KnowledgeChunkingStrategy {
  readonly key: string;
  readonly version: string;
  chunk(sourceText: string): readonly KnowledgeChunkDraft[];
}

export class EmptyChunkSourceError extends Error {}

export class UnknownChunkingStrategyError extends Error {}

type Boundary = Readonly<{ end: number; kind: string }>;

const MAX_CHUNK_LENGTH = 1_000;
const MIN_BOUNDARY_LENGTH = 600;

function findBoundary(text: string, start: number): Boundary {
  let maximumEnd = Math.min(start + MAX_CHUNK_LENGTH, text.length);
  if (maximumEnd === text.length) {
    return { end: maximumEnd, kind: 'source-end' };
  }
  const previousCodeUnit = text.charCodeAt(maximumEnd - 1);
  const nextCodeUnit = text.charCodeAt(maximumEnd);
  if (
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    maximumEnd -= 1;
  }

  const minimumEnd = Math.min(start + MIN_BOUNDARY_LENGTH, maximumEnd);
  const window = text.slice(minimumEnd, maximumEnd);
  for (const [separator, kind] of [
    ['\n\n', 'paragraph'],
    ['\n', 'line'],
  ] as const) {
    const position = window.lastIndexOf(separator);
    if (position >= 0) {
      return { end: minimumEnd + position + separator.length, kind };
    }
  }

  for (let index = maximumEnd - 1; index >= minimumEnd; index -= 1) {
    if (/\s/u.test(text[index] ?? '')) {
      return { end: index + 1, kind: 'whitespace' };
    }
  }
  return { end: maximumEnd, kind: 'hard-limit' };
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(text[trimmedStart] ?? '')) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/u.test(text[trimmedEnd - 1] ?? '')) {
    trimmedEnd -= 1;
  }
  return { start: trimmedStart, end: trimmedEnd };
}

/**
 * Dependency-free MVP strategy. Offsets are zero-based UTF-16 code-unit indexes
 * with an exclusive end, matching JavaScript string slicing.
 */
export const paragraphWindowStrategyV1: KnowledgeChunkingStrategy = {
  key: 'paragraph-window',
  version: '1.0.0',
  chunk(sourceText) {
    if (!sourceText.trim()) {
      throw new EmptyChunkSourceError('The selected source contains no chunkable text.');
    }

    const chunks: KnowledgeChunkDraft[] = [];
    let cursor = 0;
    while (cursor < sourceText.length) {
      const boundary = findBoundary(sourceText, cursor);
      const range = trimRange(sourceText, cursor, boundary.end);
      if (range.start < range.end) {
        const text = sourceText.slice(range.start, range.end);
        chunks.push({
          characterEnd: range.end,
          characterStart: range.start,
          metadata: { boundary: boundary.kind },
          ordinal: chunks.length,
          sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
          text,
          tokenEstimate: Math.max(1, Math.ceil(Array.from(text).length / 4)),
        });
      }
      cursor = boundary.end;
    }

    if (!chunks.length) {
      throw new EmptyChunkSourceError('The selected source contains no chunkable text.');
    }
    return chunks;
  },
};

export class KnowledgeChunkingStrategyRegistry {
  readonly #current: KnowledgeChunkingStrategy;
  readonly #strategies: ReadonlyMap<string, KnowledgeChunkingStrategy>;

  constructor(strategies: readonly KnowledgeChunkingStrategy[], current = strategies[0]) {
    if (!current || !strategies.length) {
      throw new UnknownChunkingStrategyError('At least one chunking strategy is required.');
    }
    this.#current = current;
    this.#strategies = new Map(
      strategies.map((strategy) => [`${strategy.key}:${strategy.version}`, strategy]),
    );
  }

  getCurrent(): KnowledgeChunkingStrategy {
    return this.#current;
  }

  getVersion(key: string, version: string): KnowledgeChunkingStrategy {
    const strategy = this.#strategies.get(`${key}:${version}`);
    if (!strategy) {
      throw new UnknownChunkingStrategyError(`Chunking strategy ${key} ${version} is unavailable.`);
    }
    return strategy;
  }
}

export function createDefaultKnowledgeChunkingStrategyRegistry() {
  return new KnowledgeChunkingStrategyRegistry([paragraphWindowStrategyV1]);
}
