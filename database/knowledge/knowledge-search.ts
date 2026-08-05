import { Prisma, type PrismaClient } from '../generated/client/client';
import {
  KnowledgeAuthorizationError,
  requireKnowledgeWorkspaceAccess,
} from './knowledge-documents';
import {
  EmbeddingProviderError,
  type EmbeddingProvider,
  type EmbeddingProviderRegistry,
} from '../../services/embeddings/embedding-provider';

export const KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS = 500;
export const KNOWLEDGE_SEARCH_MAX_RESULTS = 50;
export const KNOWLEDGE_SEARCH_MAX_PER_SOURCE = 10;

const DEFAULT_RESULT_LIMIT = 20;
const DEFAULT_PER_SOURCE_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const CANDIDATE_MULTIPLIER = 10;
const MAX_CANDIDATES_PER_MODE = 300;
const RRF_CONSTANT = 60;

export type KnowledgeSearchMode = 'hybrid' | 'keyword' | 'semantic';
export type KnowledgeSearchSourceType = 'attachment' | 'document';

export type KnowledgeSearchScore = Readonly<{
  final: number;
  keywordRank: number | null;
  keywordScore: number | null;
  semanticRank: number | null;
  semanticScore: number | null;
}>;

export type KnowledgeSearchResult = Readonly<{
  attachmentId: string | null;
  chunkId: string;
  chunkOrdinal: number;
  chunkSetId: string;
  characterEnd: number | null;
  characterStart: number | null;
  documentId: string;
  documentSlug: string;
  documentTitle: string;
  documentVersion: number | null;
  excerpt: string;
  extractionVersion: number | null;
  originalFilename: string | null;
  score: KnowledgeSearchScore;
  sourceId: string;
  sourceType: KnowledgeSearchSourceType;
}>;

export type KnowledgeSearchRequest = Readonly<{
  limit?: number;
  mode: KnowledgeSearchMode;
  perSourceLimit?: number;
  query: string;
}>;

export type KnowledgeSearchDependencies = Readonly<{
  maxResults?: number;
  perSourceLimit?: number;
  providers?: EmbeddingProviderRegistry;
  timeoutMs?: number;
}>;

export class KnowledgeSearchError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class KnowledgeSearchValidationError extends KnowledgeSearchError {}
export class KnowledgeSearchProviderError extends KnowledgeSearchError {}

type RawSearchCandidate = Readonly<{
  attachmentId: string | null;
  chunkId: string;
  chunkOrdinal: number;
  chunkSetId: string;
  characterEnd: number | null;
  characterStart: number | null;
  documentId: string;
  documentSlug: string;
  documentTitle: string;
  documentVersion: number | null;
  extractionVersion: number | null;
  originalFilename: string | null;
  rawScore: number;
  sourceId: string;
  sourceType: 'ATTACHMENT_EXTRACTION' | 'MARKDOWN_DOCUMENT';
  text: string;
}>;

type RankedCandidate = Readonly<{
  candidate: RawSearchCandidate;
  keywordRank: number | null;
  keywordScore: number | null;
  semanticRank: number | null;
  semanticScore: number | null;
}>;

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new KnowledgeSearchValidationError(
      `${label} must be an integer between 1 and ${maximum}.`,
      'search_limit_invalid',
    );
  }
  return resolved;
}

function normalizedQuery(value: string): { query: string; terms: string } | null {
  const query = value.normalize('NFKC').trim();
  if (query.length > KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS) {
    throw new KnowledgeSearchValidationError(
      `Search queries must not exceed ${KNOWLEDGE_SEARCH_QUERY_MAX_CHARACTERS} characters.`,
      'search_query_too_long',
    );
  }
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
  return terms.length > 0 ? { query, terms: terms.join(' ') } : null;
}

function timeoutMs(value: number | undefined): number {
  return positiveInteger(value, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'Search timeout');
}

function eligibleSourceCtes(workspaceId: string): Prisma.Sql {
  return Prisma.sql`
    WITH document_sources AS (
      SELECT DISTINCT ON (document."id")
        'MARKDOWN_DOCUMENT'::text AS "sourceType",
        document."id" AS "sourceId",
        document."id" AS "documentId",
        document."slug" AS "documentSlug",
        document."title" AS "documentTitle",
        version."versionNumber" AS "documentVersion",
        NULL::uuid AS "attachmentId",
        NULL::text AS "originalFilename",
        NULL::integer AS "extractionVersion",
        chunk_set."id" AS "chunkSetId",
        document."title" AS "searchLabel"
      FROM "knowledge_documents" document
      JOIN "workspaces" workspace
        ON workspace."id" = document."workspaceId"
        AND workspace."status" = 'ACTIVE'
        AND workspace."deletedAt" IS NULL
      JOIN "organizations" organization
        ON organization."id" = workspace."organizationId"
        AND organization."status" = 'ACTIVE'
        AND organization."deletedAt" IS NULL
      JOIN "knowledge_document_versions" version
        ON version."documentId" = document."id"
        AND version."versionNumber" = document."version"
      JOIN "knowledge_chunk_sets" chunk_set
        ON chunk_set."documentVersionId" = version."id"
        AND chunk_set."workspaceId" = document."workspaceId"
        AND chunk_set."sourceType" = 'MARKDOWN_DOCUMENT'
      JOIN "knowledge_chunking_jobs" chunk_job
        ON chunk_job."id" = chunk_set."createdByJobId"
        AND chunk_job."status" = 'SUCCEEDED'
      WHERE document."workspaceId" = ${workspaceId}::uuid
        AND document."status" = 'ACTIVE'
      ORDER BY document."id", chunk_set."createdAt" DESC, chunk_set."id" DESC
    ),
    attachment_sources AS (
      SELECT DISTINCT ON (attachment."id")
        'ATTACHMENT_EXTRACTION'::text AS "sourceType",
        attachment."id" AS "sourceId",
        document."id" AS "documentId",
        document."slug" AS "documentSlug",
        document."title" AS "documentTitle",
        NULL::integer AS "documentVersion",
        attachment."id" AS "attachmentId",
        attachment."originalFilename" AS "originalFilename",
        extraction."extractionNumber" AS "extractionVersion",
        chunk_set."id" AS "chunkSetId",
        attachment."originalFilename" AS "searchLabel"
      FROM "knowledge_attachments" attachment
      JOIN "knowledge_documents" document
        ON document."id" = attachment."documentId"
        AND document."workspaceId" = attachment."workspaceId"
        AND document."status" = 'ACTIVE'
      JOIN "workspaces" workspace
        ON workspace."id" = attachment."workspaceId"
        AND workspace."status" = 'ACTIVE'
        AND workspace."deletedAt" IS NULL
      JOIN "organizations" organization
        ON organization."id" = workspace."organizationId"
        AND organization."status" = 'ACTIVE'
        AND organization."deletedAt" IS NULL
      JOIN "knowledge_attachment_extractions" extraction
        ON extraction."attachmentId" = attachment."id"
        AND extraction."workspaceId" = attachment."workspaceId"
      JOIN "knowledge_chunk_sets" chunk_set
        ON chunk_set."attachmentExtractionId" = extraction."id"
        AND chunk_set."workspaceId" = attachment."workspaceId"
        AND chunk_set."sourceType" = 'ATTACHMENT_EXTRACTION'
      JOIN "knowledge_chunking_jobs" chunk_job
        ON chunk_job."id" = chunk_set."createdByJobId"
        AND chunk_job."status" = 'SUCCEEDED'
      WHERE attachment."workspaceId" = ${workspaceId}::uuid
        AND attachment."status" = 'ACTIVE'
      ORDER BY attachment."id", extraction."extractionNumber" DESC,
        chunk_set."createdAt" DESC, chunk_set."id" DESC
    ),
    eligible_sources AS (
      SELECT * FROM document_sources
      UNION ALL
      SELECT * FROM attachment_sources
    ),
    candidate_chunks AS (
      SELECT
        source.*,
        chunk."id" AS "chunkId",
        chunk."ordinal" AS "chunkOrdinal",
        chunk."text",
        chunk."characterStart",
        chunk."characterEnd",
        chunk."sha256",
        chunk."searchVector",
        row_number() OVER (
          PARTITION BY source."sourceType", source."sourceId", chunk."sha256"
          ORDER BY chunk."ordinal" ASC, chunk."id" ASC
        ) AS "duplicateRank"
      FROM eligible_sources source
      JOIN "knowledge_chunks" chunk ON chunk."chunkSetId" = source."chunkSetId"
    )
  `;
}

async function timedQuery(
  prisma: PrismaClient,
  query: Prisma.Sql,
  queryTimeoutMs: number,
): Promise<RawSearchCandidate[]> {
  return prisma.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT set_config('statement_timeout', ${`${queryTimeoutMs}ms`}, true)
      `;
      return transaction.$queryRaw<RawSearchCandidate[]>(query);
    },
    { timeout: queryTimeoutMs + 1_000 },
  );
}

function keywordCandidates(
  prisma: PrismaClient,
  workspaceId: string,
  terms: string,
  limit: number,
  queryTimeoutMs: number,
): Promise<RawSearchCandidate[]> {
  return timedQuery(
    prisma,
    Prisma.sql`
      ${eligibleSourceCtes(workspaceId)}
      SELECT
        candidate."sourceType",
        candidate."sourceId",
        candidate."documentId",
        candidate."documentSlug",
        candidate."documentTitle",
        candidate."documentVersion",
        candidate."attachmentId",
        candidate."originalFilename",
        candidate."extractionVersion",
        candidate."chunkSetId",
        candidate."chunkId",
        candidate."chunkOrdinal",
        candidate."characterStart",
        candidate."characterEnd",
        candidate."text",
        ts_rank_cd(
          setweight(to_tsvector('simple', coalesce(candidate."searchLabel", '')), 'A') ||
            candidate."searchVector",
          plainto_tsquery('simple', ${terms})
        )::double precision AS "rawScore"
      FROM candidate_chunks candidate
      WHERE candidate."duplicateRank" = 1
        AND (
          candidate."searchVector" @@ plainto_tsquery('simple', ${terms})
          OR to_tsvector('simple', coalesce(candidate."searchLabel", ''))
            @@ plainto_tsquery('simple', ${terms})
        )
      ORDER BY "rawScore" DESC, candidate."sourceType" ASC,
        candidate."sourceId" ASC, candidate."chunkOrdinal" ASC, candidate."chunkId" ASC
      LIMIT ${limit}
    `,
    queryTimeoutMs,
  );
}

function semanticCandidates(
  prisma: PrismaClient,
  workspaceId: string,
  provider: EmbeddingProvider,
  vector: readonly number[],
  limit: number,
  queryTimeoutMs: number,
): Promise<RawSearchCandidate[]> {
  return timedQuery(
    prisma,
    Prisma.sql`
      ${eligibleSourceCtes(workspaceId)},
      latest_embedding_sets AS (
        SELECT DISTINCT ON (embedding_set."chunkSetId")
          embedding_set."id",
          embedding_set."chunkSetId"
        FROM "knowledge_embedding_sets" embedding_set
        JOIN "knowledge_embedding_jobs" embedding_job
          ON embedding_job."id" = embedding_set."createdByJobId"
          AND embedding_job."status" = 'SUCCEEDED'
        WHERE embedding_set."workspaceId" = ${workspaceId}::uuid
          AND embedding_set."providerKey" = ${provider.providerKey}
          AND embedding_set."modelKey" = ${provider.modelKey}
          AND embedding_set."modelVersion" = ${provider.modelVersion}
          AND embedding_set."dimensions" = ${provider.dimensions}
        ORDER BY embedding_set."chunkSetId", embedding_set."createdAt" DESC,
          embedding_set."id" DESC
      )
      SELECT
        candidate."sourceType",
        candidate."sourceId",
        candidate."documentId",
        candidate."documentSlug",
        candidate."documentTitle",
        candidate."documentVersion",
        candidate."attachmentId",
        candidate."originalFilename",
        candidate."extractionVersion",
        candidate."chunkSetId",
        candidate."chunkId",
        candidate."chunkOrdinal",
        candidate."characterStart",
        candidate."characterEnd",
        candidate."text",
        (1 - (embedding."vector" <=> ${JSON.stringify(vector)}::vector))::double precision
          AS "rawScore"
      FROM candidate_chunks candidate
      JOIN latest_embedding_sets embedding_set
        ON embedding_set."chunkSetId" = candidate."chunkSetId"
      JOIN "knowledge_embeddings" embedding
        ON embedding."embeddingSetId" = embedding_set."id"
        AND embedding."chunkId" = candidate."chunkId"
        AND embedding."ordinal" = candidate."chunkOrdinal"
      WHERE candidate."duplicateRank" = 1
      ORDER BY "rawScore" DESC, candidate."sourceType" ASC,
        candidate."sourceId" ASC, candidate."chunkOrdinal" ASC, candidate."chunkId" ASC
      LIMIT ${limit}
    `,
    queryTimeoutMs,
  );
}

async function embedQuery(
  provider: EmbeddingProvider,
  query: string,
  queryTimeoutMs: number,
): Promise<readonly number[]> {
  if (query.length > provider.maxInputCharacters) {
    throw new KnowledgeSearchValidationError(
      'The query exceeds the configured embedding provider input limit.',
      'search_provider_input_limit',
    );
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const vectors = await Promise.race([
      provider.embed([query], { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new KnowledgeSearchProviderError(
              'Semantic search timed out. Try again.',
              'search_provider_timeout',
            ),
          );
          controller.abort();
        }, queryTimeoutMs);
      }),
    ]);
    const vector = vectors[0];
    if (
      vectors.length !== 1 ||
      !vector ||
      vector.length !== provider.dimensions ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new KnowledgeSearchProviderError(
        'The embedding provider returned an invalid query vector.',
        'search_provider_output_invalid',
      );
    }
    return vector;
  } catch (error) {
    if (error instanceof KnowledgeSearchError) throw error;
    if (error instanceof EmbeddingProviderError) {
      throw new KnowledgeSearchProviderError(
        'Semantic search is temporarily unavailable.',
        error.code,
      );
    }
    throw new KnowledgeSearchProviderError(
      'Semantic search is temporarily unavailable.',
      'search_provider_failed',
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateKey(candidate: RawSearchCandidate): string {
  return candidate.chunkId;
}

function rankCandidates(
  keyword: readonly RawSearchCandidate[],
  semantic: readonly RawSearchCandidate[],
): RankedCandidate[] {
  const candidates = new Map<string, RankedCandidate>();
  keyword.forEach((candidate, index) => {
    candidates.set(candidateKey(candidate), {
      candidate,
      keywordRank: index + 1,
      keywordScore: candidate.rawScore,
      semanticRank: null,
      semanticScore: null,
    });
  });
  semantic.forEach((candidate, index) => {
    const key = candidateKey(candidate);
    const current = candidates.get(key);
    candidates.set(key, {
      candidate: current?.candidate ?? candidate,
      keywordRank: current?.keywordRank ?? null,
      keywordScore: current?.keywordScore ?? null,
      semanticRank: index + 1,
      semanticScore: candidate.rawScore,
    });
  });
  return [...candidates.values()];
}

function finalScore(candidate: RankedCandidate): number {
  return (
    (candidate.keywordRank ? 1 / (RRF_CONSTANT + candidate.keywordRank) : 0) +
    (candidate.semanticRank ? 1 / (RRF_CONSTANT + candidate.semanticRank) : 0)
  );
}

function sourceType(value: RawSearchCandidate['sourceType']): KnowledgeSearchSourceType {
  return value === 'MARKDOWN_DOCUMENT' ? 'document' : 'attachment';
}

function toResult(candidate: RankedCandidate): KnowledgeSearchResult {
  const raw = candidate.candidate;
  return {
    attachmentId: raw.attachmentId,
    characterEnd: raw.characterEnd,
    characterStart: raw.characterStart,
    chunkId: raw.chunkId,
    chunkOrdinal: raw.chunkOrdinal,
    chunkSetId: raw.chunkSetId,
    documentId: raw.documentId,
    documentSlug: raw.documentSlug,
    documentTitle: raw.documentTitle,
    documentVersion: raw.documentVersion,
    excerpt: raw.text.replace(/\s+/gu, ' ').trim().slice(0, 480),
    extractionVersion: raw.extractionVersion,
    originalFilename: raw.originalFilename,
    score: {
      final: finalScore(candidate),
      keywordRank: candidate.keywordRank,
      keywordScore: candidate.keywordScore,
      semanticRank: candidate.semanticRank,
      semanticScore: candidate.semanticScore,
    },
    sourceId: raw.sourceId,
    sourceType: sourceType(raw.sourceType),
  };
}

export function isKnowledgeSearchMode(value: unknown): value is KnowledgeSearchMode {
  return value === 'keyword' || value === 'semantic' || value === 'hybrid';
}

export async function searchWorkspaceKnowledge(
  prisma: PrismaClient,
  dependencies: KnowledgeSearchDependencies,
  actorUserId: string,
  workspaceId: string,
  request: KnowledgeSearchRequest,
): Promise<KnowledgeSearchResult[]> {
  await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  const normalized = normalizedQuery(request.query);
  if (!normalized) return [];
  if (!isKnowledgeSearchMode(request.mode)) {
    throw new KnowledgeSearchValidationError(
      'The selected search mode is invalid.',
      'mode_invalid',
    );
  }

  const maximumResults = positiveInteger(
    dependencies.maxResults,
    KNOWLEDGE_SEARCH_MAX_RESULTS,
    KNOWLEDGE_SEARCH_MAX_RESULTS,
    'Configured search result limit',
  );
  const resultLimit = positiveInteger(
    request.limit,
    Math.min(DEFAULT_RESULT_LIMIT, maximumResults),
    maximumResults,
    'Search result limit',
  );
  const maximumPerSource = positiveInteger(
    dependencies.perSourceLimit,
    DEFAULT_PER_SOURCE_LIMIT,
    KNOWLEDGE_SEARCH_MAX_PER_SOURCE,
    'Configured per-source result limit',
  );
  const perSourceLimit = positiveInteger(
    request.perSourceLimit,
    maximumPerSource,
    maximumPerSource,
    'Per-source result limit',
  );
  const queryTimeoutMs = timeoutMs(dependencies.timeoutMs);
  const candidateLimit = Math.min(MAX_CANDIDATES_PER_MODE, resultLimit * CANDIDATE_MULTIPLIER);

  let keyword: RawSearchCandidate[] = [];
  let semantic: RawSearchCandidate[] = [];
  if (request.mode === 'keyword' || request.mode === 'hybrid') {
    keyword = await keywordCandidates(
      prisma,
      workspaceId,
      normalized.terms,
      candidateLimit,
      queryTimeoutMs,
    );
  }
  if (request.mode === 'semantic' || request.mode === 'hybrid') {
    if (!dependencies.providers) {
      throw new KnowledgeSearchProviderError(
        'Semantic search is not configured.',
        'search_provider_not_configured',
      );
    }
    const provider = dependencies.providers.getCurrent();
    const queryVector = await embedQuery(provider, normalized.query, queryTimeoutMs);
    semantic = await semanticCandidates(
      prisma,
      workspaceId,
      provider,
      queryVector,
      candidateLimit,
      queryTimeoutMs,
    );
  }

  const ranked = rankCandidates(keyword, semantic).sort((left, right) => {
    const byScore = finalScore(right) - finalScore(left);
    if (byScore !== 0) return byScore;
    const byType = compareStrings(left.candidate.sourceType, right.candidate.sourceType);
    if (byType !== 0) return byType;
    const bySource = compareStrings(left.candidate.sourceId, right.candidate.sourceId);
    if (bySource !== 0) return bySource;
    const byOrdinal = left.candidate.chunkOrdinal - right.candidate.chunkOrdinal;
    return byOrdinal !== 0
      ? byOrdinal
      : compareStrings(left.candidate.chunkId, right.candidate.chunkId);
  });

  const sourceCounts = new Map<string, number>();
  const results: KnowledgeSearchResult[] = [];
  for (const candidate of ranked) {
    const key = `${candidate.candidate.sourceType}:${candidate.candidate.sourceId}`;
    const count = sourceCounts.get(key) ?? 0;
    if (count >= perSourceLimit) continue;
    sourceCounts.set(key, count + 1);
    results.push(toResult(candidate));
    if (results.length === resultLimit) break;
  }
  return results;
}

export { KnowledgeAuthorizationError };
