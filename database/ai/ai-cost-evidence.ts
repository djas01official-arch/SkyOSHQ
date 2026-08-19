import {
  AiRunCostEvidenceSource,
  type AiRunCostEvidence,
  type PrismaClient,
} from '../generated/client/client';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SOURCE_REFERENCE_MAX_LENGTH = 512;
const INPUT_KEYS = [
  'costUsd',
  'observedAt',
  'providerKey',
  'runId',
  'source',
  'sourceReference',
] as const;

export type RecordAiRunCostEvidenceInput = Readonly<{
  costUsd: FixedPrecisionUsd;
  observedAt?: Date;
  providerKey: string;
  runId: string;
  source: AiRunCostEvidenceSource;
  sourceReference: string;
}>;

export type AiRunAuthoritativeCostInspection = Readonly<{
  authoritativeCostUsd: FixedPrecisionUsd | null;
  classification: 'NO_EVIDENCE' | 'AUTHORITATIVE_COST' | 'CONFLICTING_EVIDENCE';
  conflictingCosts: readonly FixedPrecisionUsd[];
  evidenceCount: number;
  runId: string;
  sources: readonly AiRunCostEvidenceSource[];
}>;

export type AiRunPersistedAccountingCostResolution =
  | Readonly<{
      classification: 'KNOWN_COST';
      costUsd: FixedPrecisionUsd;
      source: 'AUTHORITATIVE_EVIDENCE' | 'EXECUTION_ACCOUNTING';
    }>
  | Readonly<{ classification: 'NOT_ATTEMPTED' }>
  | Readonly<{ classification: 'UNKNOWN_COST' }>
  | Readonly<{ classification: 'CONFLICTING_COST_EVIDENCE' }>;

type PersistedCostUsdValue = Readonly<{ toFixed(decimalPlaces: number): string }>;
type PersistedCostEvidence = Readonly<{ costUsd: PersistedCostUsdValue }>;

export type AiRoutingDecisionAuthoritativeCostInspection = Readonly<{
  attemptedRunCount: number;
  routingDecisionId: string;
  runs: ReadonlyArray<
    Readonly<{
      authoritative: AiRunAuthoritativeCostInspection;
      executionAccountedCostUsd: FixedPrecisionUsd | null;
      providerAttempted: boolean | null;
      runId: string;
    }>
  >;
  workspaceId: string;
}>;

export class AiRunCostEvidenceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiRunCostEvidenceConflictError extends AiRunCostEvidenceError {}
export class AiRunCostEvidenceNotFoundError extends AiRunCostEvidenceError {}
export class AiRunCostEvidenceStateError extends AiRunCostEvidenceError {}
export class AiRunCostEvidenceValidationError extends AiRunCostEvidenceError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isEvidenceSource(value: unknown): value is AiRunCostEvidenceSource {
  return (
    typeof value === 'string' &&
    (Object.values(AiRunCostEvidenceSource) as string[]).includes(value)
  );
}

function validObservedAt(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function invalidInput(): never {
  throw new AiRunCostEvidenceValidationError(
    'The AI run cost evidence input is invalid.',
    'ai_run_cost_evidence_invalid',
  );
}

function validateRecordInput(input: RecordAiRunCostEvidenceInput): void {
  if (!isRecord(input)) invalidInput();
  const keys = Object.keys(input);
  if (
    keys.some((key) => !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number])) ||
    !keys.includes('costUsd') ||
    !keys.includes('providerKey') ||
    !keys.includes('runId') ||
    !keys.includes('source') ||
    !keys.includes('sourceReference') ||
    !validUuid(input.runId) ||
    !isFixedPrecisionUsd(input.costUsd) ||
    !isEvidenceSource(input.source) ||
    typeof input.providerKey !== 'string' ||
    !PROVIDER_KEY_PATTERN.test(input.providerKey) ||
    typeof input.sourceReference !== 'string' ||
    input.sourceReference.length === 0 ||
    input.sourceReference.length > SOURCE_REFERENCE_MAX_LENGTH ||
    input.sourceReference !== input.sourceReference.trim() ||
    (input.observedAt !== undefined && !validObservedAt(input.observedAt))
  ) {
    invalidInput();
  }
}

function persistedCostUsd(value: { toFixed(decimalPlaces: number): string }): FixedPrecisionUsd {
  const costUsd = value.toFixed(12);
  if (!isFixedPrecisionUsd(costUsd)) {
    throw new AiRunCostEvidenceStateError(
      'The persisted AI run cost evidence amount is invalid.',
      'ai_run_cost_evidence_state_invalid',
    );
  }
  return costUsd;
}

function inspectPersistedEvidenceCosts(
  runId: string,
  evidence: readonly PersistedCostEvidence[],
): AiRunAuthoritativeCostInspection {
  const costs = evidence.map(({ costUsd }) => persistedCostUsd(costUsd));
  const distinctCosts = [...new Set(costs)].sort(compareFixedPrecisionUsd);
  if (distinctCosts.length === 0) {
    return Object.freeze({
      authoritativeCostUsd: null,
      classification: 'NO_EVIDENCE' as const,
      conflictingCosts: Object.freeze([]),
      evidenceCount: 0,
      runId,
      sources: Object.freeze([]),
    });
  }
  if (distinctCosts.length === 1) {
    return Object.freeze({
      authoritativeCostUsd: distinctCosts[0]!,
      classification: 'AUTHORITATIVE_COST' as const,
      conflictingCosts: Object.freeze([]),
      evidenceCount: evidence.length,
      runId,
      sources: Object.freeze([]),
    });
  }
  return Object.freeze({
    authoritativeCostUsd: null,
    classification: 'CONFLICTING_EVIDENCE' as const,
    conflictingCosts: Object.freeze(distinctCosts),
    evidenceCount: evidence.length,
    runId,
    sources: Object.freeze([]),
  });
}

/**
 * Resolves persisted accounting for one run without repricing or changing the
 * immutable run. Execution-time accounting always wins; trusted evidence only
 * supplements a missing execution-time cost for an attempted provider call.
 */
export function resolvePersistedAiRunAccountingCost(
  input: Readonly<{
    estimatedCostUsd: PersistedCostUsdValue | null;
    evidence: readonly PersistedCostEvidence[];
    providerAttempted: boolean;
    runId: string;
  }>,
): AiRunPersistedAccountingCostResolution {
  if (!input.providerAttempted) {
    return Object.freeze({ classification: 'NOT_ATTEMPTED' as const });
  }
  if (input.estimatedCostUsd !== null) {
    return Object.freeze({
      classification: 'KNOWN_COST' as const,
      costUsd: persistedCostUsd(input.estimatedCostUsd),
      source: 'EXECUTION_ACCOUNTING' as const,
    });
  }
  const authoritative = inspectPersistedEvidenceCosts(input.runId, input.evidence);
  if (authoritative.classification === 'AUTHORITATIVE_COST') {
    return Object.freeze({
      classification: 'KNOWN_COST' as const,
      costUsd: authoritative.authoritativeCostUsd!,
      source: 'AUTHORITATIVE_EVIDENCE' as const,
    });
  }
  return Object.freeze({
    classification:
      authoritative.classification === 'CONFLICTING_EVIDENCE'
        ? ('CONFLICTING_COST_EVIDENCE' as const)
        : ('UNKNOWN_COST' as const),
  });
}

function sameObservedAt(left: Date | null, right: Date | undefined): boolean {
  return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

function sameEvidence(evidence: AiRunCostEvidence, input: RecordAiRunCostEvidenceInput): boolean {
  return (
    evidence.runId === input.runId &&
    evidence.source === input.source &&
    evidence.providerKey === input.providerKey &&
    evidence.sourceReference === input.sourceReference &&
    persistedCostUsd(evidence.costUsd) === input.costUsd &&
    sameObservedAt(evidence.observedAt, input.observedAt)
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

async function existingEvidenceForSourceReference(
  prisma: PrismaClient,
  input: RecordAiRunCostEvidenceInput,
): Promise<AiRunCostEvidence | null> {
  return prisma.aiRunCostEvidence.findFirst({
    where: {
      providerKey: input.providerKey,
      source: input.source,
      sourceReference: input.sourceReference,
    },
  });
}

/**
 * Records an immutable provider or trusted-accounting statement for one run.
 * This is an internal ingestion boundary, deliberately not a browser-facing or
 * workspace-member service. Callers must obtain the source evidence from a
 * separately trusted accounting integration.
 */
export async function recordAiRunCostEvidence(
  prisma: PrismaClient,
  input: RecordAiRunCostEvidenceInput,
): Promise<AiRunCostEvidence> {
  validateRecordInput(input);

  const run = await prisma.aiRun.findUnique({
    where: { id: input.runId },
    select: { id: true, providerKey: true, workspaceId: true },
  });
  if (!run) {
    throw new AiRunCostEvidenceNotFoundError(
      'The AI run for cost evidence was not found.',
      'ai_run_cost_evidence_run_not_found',
    );
  }
  if (run.providerKey !== input.providerKey) {
    throw new AiRunCostEvidenceConflictError(
      'The AI run cost evidence provider does not match the target run.',
      'ai_run_cost_evidence_provider_mismatch',
    );
  }

  const existing = await existingEvidenceForSourceReference(prisma, input);
  if (existing) {
    if (sameEvidence(existing, input)) return existing;
    throw new AiRunCostEvidenceConflictError(
      'The immutable AI run cost evidence source reference conflicts with existing evidence.',
      'ai_run_cost_evidence_source_reference_conflict',
    );
  }

  try {
    return await prisma.aiRunCostEvidence.create({
      data: {
        costUsd: input.costUsd,
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
        providerKey: input.providerKey,
        runId: run.id,
        source: input.source,
        sourceReference: input.sourceReference,
        workspaceId: run.workspaceId,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await existingEvidenceForSourceReference(prisma, input);
    if (concurrent && sameEvidence(concurrent, input)) return concurrent;
    throw new AiRunCostEvidenceConflictError(
      'The immutable AI run cost evidence source reference conflicts with existing evidence.',
      'ai_run_cost_evidence_source_reference_conflict',
    );
  }
}

/**
 * Reads one run's append-only evidence without selecting a source reference or
 * other raw provider provenance. Equal evidence corroborates one total; unlike
 * charge components, evidence is never summed.
 */
export async function inspectAiRunAuthoritativeCost(
  prisma: PrismaClient,
  runId: string,
): Promise<AiRunAuthoritativeCostInspection> {
  if (!validUuid(runId)) invalidInput();
  const run = await prisma.aiRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) {
    throw new AiRunCostEvidenceNotFoundError(
      'The AI run for cost evidence was not found.',
      'ai_run_cost_evidence_run_not_found',
    );
  }
  const evidence = await prisma.aiRunCostEvidence.findMany({
    where: { runId: run.id },
    select: { costUsd: true, source: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const sources = [...new Set(evidence.map(({ source }) => source))];
  const inspection = inspectPersistedEvidenceCosts(run.id, evidence);
  return Object.freeze({ ...inspection, sources: Object.freeze(sources) });
}

/**
 * Inspects durable evidence through one exact routing-decision lineage. Only
 * runs known to have attempted a provider invocation require evidence; current
 * execution-time accounting remains separate and is not re-priced here.
 */
export async function inspectAiRoutingDecisionAuthoritativeCost(
  prisma: PrismaClient,
  input: Readonly<{ routingDecisionId: string; workspaceId: string }>,
): Promise<AiRoutingDecisionAuthoritativeCostInspection> {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 2 ||
    !validUuid(input.routingDecisionId) ||
    !validUuid(input.workspaceId)
  ) {
    invalidInput();
  }
  const routingDecision = await prisma.aiRoutingDecision.findFirst({
    where: { id: input.routingDecisionId, workspaceId: input.workspaceId },
    select: {
      id: true,
      runs: {
        orderBy: [{ orchestrationStep: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          estimatedCostUsd: true,
          id: true,
          providerAttempted: true,
        },
      },
    },
  });
  if (!routingDecision) {
    throw new AiRunCostEvidenceNotFoundError(
      'The AI routing decision for cost evidence was not found.',
      'ai_run_cost_evidence_routing_not_found',
    );
  }
  const attemptedRuns = routingDecision.runs.filter(
    ({ providerAttempted }) => providerAttempted !== false,
  );
  const runs = await Promise.all(
    attemptedRuns.map(async (run) =>
      Object.freeze({
        authoritative: await inspectAiRunAuthoritativeCost(prisma, run.id),
        executionAccountedCostUsd:
          run.estimatedCostUsd === null ? null : persistedCostUsd(run.estimatedCostUsd),
        providerAttempted: run.providerAttempted,
        runId: run.id,
      }),
    ),
  );
  return Object.freeze({
    attemptedRunCount: runs.length,
    routingDecisionId: routingDecision.id,
    runs: Object.freeze(runs),
    workspaceId: input.workspaceId,
  });
}
