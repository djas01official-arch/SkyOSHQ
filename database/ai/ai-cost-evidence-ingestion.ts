import {
  AiProviderExecutionReferenceType,
  AiRunCostEvidenceSource,
  type PrismaClient,
} from '../generated/client/client';
import { recordAiRunCostEvidence, AiRunCostEvidenceConflictError } from './ai-cost-evidence';
import {
  isFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';

const CANONICAL_PROVIDER_KEYS = ['openai', 'anthropic', 'gemini'] as const;
const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const PROVIDER_SOURCE_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const SOURCE_REFERENCE_MAX_LENGTH = 512;
const USD_PICO_DECIMALS = 12;
const NUMERIC_65_12_WHOLE_DIGITS = 53;

export type AiCostEvidenceProviderKey = (typeof CANONICAL_PROVIDER_KEYS)[number];
type ExternalAiRunCostEvidenceSource = Extract<
  AiRunCostEvidenceSource,
  'PROVIDER_USAGE_RECEIPT' | 'PROVIDER_BILLING_EXPORT'
>;

/**
 * Deliberately internal fixture contract for future trusted provider imports.
 * It is not a representation of a provider billing API response.
 */
export type ProviderCostEvidenceImportRecord = Readonly<{
  cost: ProviderCostEvidenceAmount;
  currency: string;
  modelKey?: string;
  observedAt?: string;
  providerRequestId: string;
  sourceKind: 'USAGE_RECEIPT' | 'BILLING_EXPORT';
  sourceReference: string;
}>;

export type OpenAiCostEvidenceImportRecord = ProviderCostEvidenceImportRecord;
export type AnthropicCostEvidenceImportRecord = ProviderCostEvidenceImportRecord;
export type GeminiCostEvidenceImportRecord = ProviderCostEvidenceImportRecord;

export type ProviderCostEvidenceAmount =
  | Readonly<{ kind: 'USD_DECIMAL'; value: string }>
  | Readonly<{ kind: 'USD_MICROS'; value: string }>
  | Readonly<{ kind: 'USD_NANOS'; value: string }>;

export type NormalizedAiCostEvidenceCandidate = Readonly<{
  exactCostUsd: FixedPrecisionUsd;
  modelKey: string | null;
  observedAt: Date | undefined;
  providerKey: AiCostEvidenceProviderKey;
  providerRequestId: string;
  source: ExternalAiRunCostEvidenceSource;
  sourceReference: string;
}>;

export type NormalizeProviderCostRecordResult =
  | Readonly<{ candidate: NormalizedAiCostEvidenceCandidate; status: 'NORMALIZED' }>
  | Readonly<{ reason: string; status: 'INVALID' | 'UNSUPPORTED' }>;

export type AiCostEvidenceSourceAdapter = Readonly<{
  normalize(rawRecord: unknown): NormalizeProviderCostRecordResult;
  providerKey: AiCostEvidenceProviderKey;
}>;

export type MapNormalizedCostEvidenceToAiRunResult =
  | Readonly<{ runId: string; status: 'MAPPED'; workspaceId: string }>
  | Readonly<{
      reason: string;
      status: 'UNMAPPED' | 'AMBIGUOUS' | 'PROVIDER_MISMATCH' | 'INVALID';
    }>;

export type IngestAiCostEvidenceRecordResult =
  | Readonly<{ evidenceId: string; runId: string; status: 'RECORDED' | 'ALREADY_RECORDED' }>
  | Readonly<{
      reason: string;
      status:
        'INVALID' | 'UNSUPPORTED' | 'UNMAPPED' | 'AMBIGUOUS' | 'PROVIDER_MISMATCH' | 'CONFLICT';
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validSourceReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SOURCE_REFERENCE_MAX_LENGTH &&
    value === value.trim() &&
    PROVIDER_SOURCE_REFERENCE_PATTERN.test(value)
  );
}

function canonicalUsd(value: unknown): FixedPrecisionUsd | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,12}))?$/u.exec(value);
  if (!match) return undefined;
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(USD_PICO_DECIMALS, '0')}`;
  return validDatabaseUsd(normalized) ? normalized : undefined;
}

function atomicUsd(value: unknown, decimals: 6 | 9): FixedPrecisionUsd | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const picoUsd = BigInt(value) * 10n ** BigInt(USD_PICO_DECIMALS - decimals);
  const digits = picoUsd.toString().padStart(USD_PICO_DECIMALS + 1, '0');
  const normalized = `${digits.slice(0, -USD_PICO_DECIMALS)}.${digits.slice(-USD_PICO_DECIMALS)}`;
  return validDatabaseUsd(normalized) ? normalized : undefined;
}

function validDatabaseUsd(value: string): value is FixedPrecisionUsd {
  const whole = value.split('.')[0];
  return (
    whole !== undefined && whole.length <= NUMERIC_65_12_WHOLE_DIGITS && isFixedPrecisionUsd(value)
  );
}

function normalizeExactUsd(value: unknown): FixedPrecisionUsd | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['kind', 'value']) ||
    typeof value.kind !== 'string'
  ) {
    return undefined;
  }
  switch (value.kind) {
    case 'USD_DECIMAL':
      return canonicalUsd(value.value);
    case 'USD_MICROS':
      return atomicUsd(value.value, 6);
    case 'USD_NANOS':
      return atomicUsd(value.value, 9);
    default:
      return undefined;
  }
}

function normalizeObservedAt(value: unknown): Date | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return null;
  }
  const observedAt = new Date(value);
  return Number.isFinite(observedAt.getTime()) && observedAt.toISOString() === value
    ? observedAt
    : null;
}

function sourceFor(value: unknown): ExternalAiRunCostEvidenceSource | undefined {
  if (value === 'USAGE_RECEIPT') return AiRunCostEvidenceSource.PROVIDER_USAGE_RECEIPT;
  if (value === 'BILLING_EXPORT') return AiRunCostEvidenceSource.PROVIDER_BILLING_EXPORT;
  return undefined;
}

function normalizeFixtureRecord(
  providerKey: AiCostEvidenceProviderKey,
  rawRecord: unknown,
): NormalizeProviderCostRecordResult {
  if (
    !isRecord(rawRecord) ||
    !hasOnlyKeys(rawRecord, [
      'cost',
      'currency',
      'modelKey',
      'observedAt',
      'providerRequestId',
      'sourceKind',
      'sourceReference',
    ])
  ) {
    return Object.freeze({ reason: 'record_shape_invalid', status: 'INVALID' as const });
  }
  if (rawRecord.currency !== 'USD') {
    return Object.freeze({ reason: 'currency_unsupported', status: 'UNSUPPORTED' as const });
  }
  const exactCostUsd = normalizeExactUsd(rawRecord.cost);
  if (!exactCostUsd) return Object.freeze({ reason: 'cost_invalid', status: 'INVALID' as const });
  if (!validSourceReference(rawRecord.sourceReference)) {
    return Object.freeze({ reason: 'source_reference_invalid', status: 'INVALID' as const });
  }
  if (
    typeof rawRecord.providerRequestId !== 'string' ||
    !PROVIDER_REQUEST_ID_PATTERN.test(rawRecord.providerRequestId)
  ) {
    return Object.freeze({ reason: 'provider_request_id_invalid', status: 'INVALID' as const });
  }
  if (
    rawRecord.modelKey !== undefined &&
    (typeof rawRecord.modelKey !== 'string' ||
      rawRecord.modelKey.length === 0 ||
      rawRecord.modelKey !== rawRecord.modelKey.trim())
  ) {
    return Object.freeze({ reason: 'model_identity_invalid', status: 'INVALID' as const });
  }
  const observedAt = normalizeObservedAt(rawRecord.observedAt);
  if (observedAt === null)
    return Object.freeze({ reason: 'observed_at_invalid', status: 'INVALID' as const });
  const source = sourceFor(rawRecord.sourceKind);
  if (!source)
    return Object.freeze({ reason: 'source_kind_unsupported', status: 'UNSUPPORTED' as const });
  return Object.freeze({
    candidate: Object.freeze({
      exactCostUsd,
      modelKey: rawRecord.modelKey ?? null,
      observedAt,
      providerKey,
      providerRequestId: rawRecord.providerRequestId,
      source,
      sourceReference: rawRecord.sourceReference,
    }),
    status: 'NORMALIZED' as const,
  });
}

function fixtureAdapter(providerKey: AiCostEvidenceProviderKey): AiCostEvidenceSourceAdapter {
  return Object.freeze({
    normalize: (rawRecord: unknown) => normalizeFixtureRecord(providerKey, rawRecord),
    providerKey,
  });
}

export const openAiCostEvidenceSourceAdapter = fixtureAdapter('openai');
export const anthropicCostEvidenceSourceAdapter = fixtureAdapter('anthropic');
export const geminiCostEvidenceSourceAdapter = fixtureAdapter('gemini');
const BUILT_IN_ADAPTERS: readonly AiCostEvidenceSourceAdapter[] = Object.freeze([
  openAiCostEvidenceSourceAdapter,
  anthropicCostEvidenceSourceAdapter,
  geminiCostEvidenceSourceAdapter,
]);

/**
 * Maps first through an execution-time durable request-reference record. Older
 * runs without such a record retain the exact conditional request-ID fallback;
 * provider, time, model, tenant, token, and latest-run heuristics are always
 * excluded from this authoritative ingestion boundary.
 */
export async function mapNormalizedCostEvidenceToAiRun(
  prisma: PrismaClient,
  candidate: NormalizedAiCostEvidenceCandidate,
): Promise<MapNormalizedCostEvidenceToAiRunResult> {
  const durableReference = await prisma.aiRunProviderExecutionReference.findFirst({
    where: {
      providerKey: candidate.providerKey,
      referenceType: AiProviderExecutionReferenceType.REQUEST_ID,
      referenceValue: candidate.providerRequestId,
    },
    select: {
      run: { select: { id: true, modelKey: true, workspaceId: true } },
    },
  });
  if (durableReference) {
    if (candidate.modelKey && durableReference.run.modelKey !== candidate.modelKey) {
      return Object.freeze({ reason: 'model_identity_mismatch', status: 'INVALID' as const });
    }
    return Object.freeze({
      runId: durableReference.run.id,
      status: 'MAPPED' as const,
      workspaceId: durableReference.run.workspaceId,
    });
  }

  const runs = await prisma.aiRun.findMany({
    where: { providerRequestId: candidate.providerRequestId },
    select: { id: true, modelKey: true, providerKey: true, workspaceId: true },
  });
  if (runs.length === 0) {
    return Object.freeze({ reason: 'provider_request_id_unmapped', status: 'UNMAPPED' as const });
  }
  const providerRuns = runs.filter((run) => run.providerKey === candidate.providerKey);
  if (providerRuns.length === 0) {
    return Object.freeze({ reason: 'provider_mismatch', status: 'PROVIDER_MISMATCH' as const });
  }
  if (providerRuns.length > 1) {
    return Object.freeze({ reason: 'provider_request_id_ambiguous', status: 'AMBIGUOUS' as const });
  }
  const run = providerRuns[0]!;
  if (candidate.modelKey !== null && candidate.modelKey !== run.modelKey) {
    return Object.freeze({ reason: 'model_identity_mismatch', status: 'INVALID' as const });
  }
  return Object.freeze({ runId: run.id, status: 'MAPPED' as const, workspaceId: run.workspaceId });
}

/**
 * Internal trusted ingestion boundary. It accepts only a built-in fixture
 * adapter, maps by an exact persisted provider request identifier, and then
 * delegates append-only idempotency to recordAiRunCostEvidence.
 */
export async function ingestAiCostEvidenceRecord(
  prisma: PrismaClient,
  adapter: AiCostEvidenceSourceAdapter,
  rawRecord: unknown,
): Promise<IngestAiCostEvidenceRecordResult> {
  if (
    !BUILT_IN_ADAPTERS.includes(adapter) ||
    !CANONICAL_PROVIDER_KEYS.includes(adapter.providerKey)
  ) {
    return Object.freeze({ reason: 'adapter_untrusted', status: 'INVALID' as const });
  }
  const normalized = adapter.normalize(rawRecord);
  if (normalized.status !== 'NORMALIZED') return normalized;
  if (normalized.candidate.providerKey !== adapter.providerKey) {
    return Object.freeze({ reason: 'adapter_provider_mismatch', status: 'INVALID' as const });
  }
  const mapped = await mapNormalizedCostEvidenceToAiRun(prisma, normalized.candidate);
  if (mapped.status !== 'MAPPED') return mapped;

  const existing = await prisma.aiRunCostEvidence.findFirst({
    where: {
      providerKey: normalized.candidate.providerKey,
      source: normalized.candidate.source,
      sourceReference: normalized.candidate.sourceReference,
    },
    select: { id: true },
  });
  try {
    const evidence = await recordAiRunCostEvidence(prisma, {
      costUsd: normalized.candidate.exactCostUsd,
      ...(normalized.candidate.observedAt ? { observedAt: normalized.candidate.observedAt } : {}),
      providerKey: normalized.candidate.providerKey,
      runId: mapped.runId,
      source: normalized.candidate.source,
      sourceReference: normalized.candidate.sourceReference,
    });
    return Object.freeze({
      evidenceId: evidence.id,
      runId: mapped.runId,
      status: existing ? ('ALREADY_RECORDED' as const) : ('RECORDED' as const),
    });
  } catch (error) {
    if (error instanceof AiRunCostEvidenceConflictError) {
      return Object.freeze({ reason: error.code, status: 'CONFLICT' as const });
    }
    throw error;
  }
}
