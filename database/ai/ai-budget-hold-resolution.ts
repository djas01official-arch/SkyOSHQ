import {
  AiBudgetLedgerEntryType,
  AiBudgetReservationHoldReason,
  AiBudgetReservationStatus,
  AiMessageRole,
  AiOrchestrationMode,
  AiOrchestrationStatus,
  AiRunStatus,
  type Prisma,
  type PrismaClient,
} from '../generated/client/client';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  sumLanguageModelCostUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  AiBudgetStateError,
  releaseAiBudgetReservation,
  requireAiBudgetAdministrationAccess,
  settleAiBudgetReservation,
} from './ai-budget';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INPUT_KEYS = ['operatorUserId', 'reservationId', 'workspaceId'] as const;
const TERMINAL_ORCHESTRATION_STATUSES: ReadonlySet<AiOrchestrationStatus> = new Set([
  AiOrchestrationStatus.SUCCEEDED,
  AiOrchestrationStatus.PARTIALLY_SUCCEEDED,
  AiOrchestrationStatus.FAILED,
  AiOrchestrationStatus.CANCELLED,
]);

export type AiBudgetHoldResolutionInput = Readonly<{
  operatorUserId: string;
  reservationId: string;
  workspaceId: string;
}>;

export type AiBudgetHoldResolutionClassification =
  | 'NOT_HELD'
  | 'ALREADY_RESOLVED'
  | 'RESOLVABLE_RELEASE_ZERO_ATTEMPT'
  | 'RESOLVABLE_SETTLE_KNOWN_COST'
  | 'BLOCKED_UNKNOWN_COST'
  | 'BLOCKED_OVERRUN'
  | 'INDETERMINATE';

export type AiBudgetHoldResolutionIndeterminateReason =
  | 'HOLD_HISTORY_MISSING'
  | 'HOLD_REASON_EVIDENCE_CONFLICT'
  | 'RESERVATION_LINEAGE_MISSING'
  | 'ROUTING_LINEAGE_INVALID'
  | 'EXECUTION_MODE_INVALID'
  | 'FAST_RUN_LINEAGE_INVALID'
  | 'MULTI_ORCHESTRATION_LINEAGE_INVALID'
  | 'RUN_ACCOUNTING_STATE_INVALID'
  | 'RUN_ATTEMPT_STATE_UNKNOWN'
  | 'EXECUTION_NOT_TERMINAL'
  | 'TERMINAL_FINANCIAL_STATE_INVALID';

type AiBudgetHoldResolutionEvidence = Readonly<{
  knownAttemptedRunCount: number;
  providerAttemptCount: number;
  reservation: Readonly<{
    heldAt: Date | null;
    holdReason: AiBudgetReservationHoldReason | null;
    id: string;
    reservedAmountUsd: FixedPrecisionUsd;
    settledAmountUsd: FixedPrecisionUsd | null;
    status: AiBudgetReservationStatus;
  }>;
  resolvedMode: AiOrchestrationMode | null;
  routingDecisionId: string | null;
  runCount: number;
  unknownCostAttemptedRunCount: number;
}>;

export type AiBudgetHoldResolutionInspection =
  | (AiBudgetHoldResolutionEvidence & Readonly<{ classification: 'NOT_HELD' }>)
  | (AiBudgetHoldResolutionEvidence &
      Readonly<{ classification: 'ALREADY_RESOLVED'; terminalStatus: 'SETTLED' | 'RELEASED' }>)
  | (AiBudgetHoldResolutionEvidence &
      Readonly<{ classification: 'RESOLVABLE_RELEASE_ZERO_ATTEMPT' }>)
  | (AiBudgetHoldResolutionEvidence &
      Readonly<{
        classification: 'RESOLVABLE_SETTLE_KNOWN_COST';
        knownAccountedCostUsd: FixedPrecisionUsd;
      }>)
  | (AiBudgetHoldResolutionEvidence &
      Readonly<{
        classification: 'BLOCKED_UNKNOWN_COST';
        knownPartialCostUsd: FixedPrecisionUsd | null;
      }>)
  | (AiBudgetHoldResolutionEvidence &
      Readonly<{
        classification: 'BLOCKED_OVERRUN';
        knownAccountedCostUsd: FixedPrecisionUsd;
      }>)
  | (AiBudgetHoldResolutionEvidence &
      Readonly<{
        classification: 'INDETERMINATE';
        reason: AiBudgetHoldResolutionIndeterminateReason;
      }>);

/**
 * Deliberately small, operator-safe projection for the held-reservations
 * Operations view. It contains only persisted request identity and financial
 * evidence; it never exposes retrieval context or provider payloads.
 */
export type WorkspaceAiBudgetHoldCandidate = Readonly<{
  classification: AiBudgetHoldResolutionClassification;
  indeterminateReason: AiBudgetHoldResolutionIndeterminateReason | null;
  knownAccountedCostUsd: FixedPrecisionUsd | null;
  knownCostAttemptCount: number;
  knownPartialCostUsd: FixedPrecisionUsd | null;
  providerAttemptCount: number;
  requestPreview: string;
  reservation: Readonly<{
    heldAt: Date | null;
    holdReason: AiBudgetReservationHoldReason | null;
    id: string;
    reservedAmountUsd: FixedPrecisionUsd;
    status: AiBudgetReservationStatus;
  }>;
  resolvedMode: AiOrchestrationMode | null;
  routingDecisionId: string | null;
  unknownCostAttemptCount: number;
}>;

export type ResolveAiBudgetHoldResult = Readonly<{
  action: 'NO_MUTATION' | 'RELEASED' | 'SETTLED';
  inspection: AiBudgetHoldResolutionInspection;
}>;

export class AiBudgetHoldResolutionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetHoldResolutionNotFoundError extends AiBudgetHoldResolutionError {}
export class AiBudgetHoldResolutionValidationError extends AiBudgetHoldResolutionError {}

const HOLD_RESOLUTION_INCLUDE = {
  routingDecision: {
    include: {
      conversation: true,
      groundedContext: true,
      runs: true,
      userMessage: true,
    },
  },
  settlementLedgerEntry: true,
} satisfies Prisma.AiBudgetReservationInclude;

type HoldResolutionReservation = Prisma.AiBudgetReservationGetPayload<{
  include: typeof HOLD_RESOLUTION_INCLUDE;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validateInput(input: AiBudgetHoldResolutionInput): void {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== INPUT_KEYS.length ||
    !Object.keys(input).every((key) => INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number])) ||
    !validUuid(input.operatorUserId) ||
    !validUuid(input.reservationId) ||
    !validUuid(input.workspaceId)
  ) {
    throw new AiBudgetHoldResolutionValidationError(
      'The AI budget hold resolution input is invalid.',
      'budget_hold_resolution_invalid',
    );
  }
}

function fixedUsd(value: { toFixed(digits?: number): string } | null): FixedPrecisionUsd | null {
  if (value === null) return null;
  const formatted = value.toFixed(12);
  return isFixedPrecisionUsd(formatted) ? formatted : null;
}

function requestPreview(value: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function isMultiMode(mode: AiOrchestrationMode): boolean {
  return (
    mode === AiOrchestrationMode.BALANCED ||
    mode === AiOrchestrationMode.DEEP ||
    mode === AiOrchestrationMode.CRITICAL
  );
}

function isTerminalRunStatus(status: AiRunStatus): boolean {
  return status === AiRunStatus.SUCCEEDED || status === AiRunStatus.FAILED;
}

function evidence(
  reservation: HoldResolutionReservation,
  overrides: Partial<AiBudgetHoldResolutionEvidence> = {},
): AiBudgetHoldResolutionEvidence {
  const runs = reservation.routingDecision?.runs ?? [];
  const attemptedCosts = runs
    .filter((run) => run.providerAttempted === true)
    .map((run) => fixedUsd(run.estimatedCostUsd));
  const knownAttemptedRunCount = attemptedCosts.filter(
    (cost): cost is FixedPrecisionUsd => cost !== null,
  ).length;
  const reservationAmount = fixedUsd(reservation.reservedAmountUsd);
  if (reservationAmount === null) {
    throw new AiBudgetHoldResolutionError(
      'The AI budget reservation monetary state is invalid.',
      'budget_hold_resolution_state_invalid',
    );
  }
  return Object.freeze({
    knownAttemptedRunCount,
    providerAttemptCount: attemptedCosts.length,
    reservation: Object.freeze({
      heldAt: reservation.heldAt,
      holdReason: reservation.holdReason,
      id: reservation.id,
      reservedAmountUsd: reservationAmount,
      settledAmountUsd: fixedUsd(reservation.settledAmountUsd),
      status: reservation.status,
    }),
    resolvedMode: reservation.routingDecision?.resolvedMode ?? null,
    routingDecisionId: reservation.routingDecisionId,
    runCount: runs.length,
    unknownCostAttemptedRunCount: attemptedCosts.length - knownAttemptedRunCount,
    ...overrides,
  });
}

function projectWorkspaceAiBudgetHold(
  inspection: AiBudgetHoldResolutionInspection,
  preview: string,
): WorkspaceAiBudgetHoldCandidate {
  return Object.freeze({
    classification: inspection.classification,
    indeterminateReason: inspection.classification === 'INDETERMINATE' ? inspection.reason : null,
    knownAccountedCostUsd:
      inspection.classification === 'RESOLVABLE_SETTLE_KNOWN_COST' ||
      inspection.classification === 'BLOCKED_OVERRUN'
        ? inspection.knownAccountedCostUsd
        : null,
    knownCostAttemptCount: inspection.knownAttemptedRunCount,
    knownPartialCostUsd:
      inspection.classification === 'BLOCKED_UNKNOWN_COST' ? inspection.knownPartialCostUsd : null,
    providerAttemptCount: inspection.providerAttemptCount,
    requestPreview: preview,
    reservation: Object.freeze({
      heldAt: inspection.reservation.heldAt,
      holdReason: inspection.reservation.holdReason,
      id: inspection.reservation.id,
      reservedAmountUsd: inspection.reservation.reservedAmountUsd,
      status: inspection.reservation.status,
    }),
    resolvedMode: inspection.resolvedMode,
    routingDecisionId: inspection.routingDecisionId,
    unknownCostAttemptCount: inspection.unknownCostAttemptedRunCount,
  });
}

function indeterminate(
  base: AiBudgetHoldResolutionEvidence,
  reason: AiBudgetHoldResolutionIndeterminateReason,
): AiBudgetHoldResolutionInspection {
  return Object.freeze({ ...base, classification: 'INDETERMINATE' as const, reason });
}

function terminalFinancialStateValid(reservation: HoldResolutionReservation): boolean {
  const settledAmount = fixedUsd(reservation.settledAmountUsd);
  const ledger = reservation.settlementLedgerEntry;
  if (reservation.status === AiBudgetReservationStatus.SETTLED) {
    return (
      settledAmount !== null &&
      ledger !== null &&
      ledger.type === AiBudgetLedgerEntryType.DEBIT &&
      fixedUsd(ledger.amountUsd) === settledAmount
    );
  }
  return (
    reservation.status === AiBudgetReservationStatus.RELEASED &&
    settledAmount === null &&
    ledger === null
  );
}

async function loadRouteOrchestrations(
  prisma: PrismaClient,
  reservation: HoldResolutionReservation,
) {
  const route = reservation.routingDecision;
  if (!route) return [];
  return prisma.aiOrchestration.findMany({
    where: {
      conversationId: route.conversationId,
      userMessageId: route.userMessageId,
      workspaceId: reservation.workspaceId,
    },
    select: {
      createdByUserId: true,
      groundedContextId: true,
      id: true,
      mode: true,
      status: true,
    },
  });
}

/**
 * Inspects existing, immutable accounting evidence for exactly one reservation.
 * It deliberately reads neither current pricing nor provider/token services.
 */
export async function inspectAiBudgetHoldResolution(
  prisma: PrismaClient,
  input: AiBudgetHoldResolutionInput,
): Promise<AiBudgetHoldResolutionInspection> {
  validateInput(input);
  await requireAiBudgetAdministrationAccess(prisma, input.operatorUserId, input.workspaceId);

  const reservation = await prisma.aiBudgetReservation.findFirst({
    where: { id: input.reservationId, workspaceId: input.workspaceId },
    include: HOLD_RESOLUTION_INCLUDE,
  });
  if (!reservation) {
    throw new AiBudgetHoldResolutionNotFoundError(
      'The AI budget reservation was not found in this workspace.',
      'budget_hold_resolution_not_found',
    );
  }

  const base = evidence(reservation);
  const historicalHold = reservation.holdReason !== null && reservation.heldAt !== null;
  if (reservation.status === AiBudgetReservationStatus.RESERVED) {
    return Object.freeze({ ...base, classification: 'NOT_HELD' as const });
  }
  if (
    reservation.status === AiBudgetReservationStatus.SETTLED ||
    reservation.status === AiBudgetReservationStatus.RELEASED
  ) {
    if (!historicalHold) return Object.freeze({ ...base, classification: 'NOT_HELD' as const });
    if (!terminalFinancialStateValid(reservation)) {
      return indeterminate(base, 'TERMINAL_FINANCIAL_STATE_INVALID');
    }
    return Object.freeze({
      ...base,
      classification: 'ALREADY_RESOLVED' as const,
      terminalStatus: reservation.status,
    });
  }
  if (reservation.status !== AiBudgetReservationStatus.HELD || !historicalHold) {
    return indeterminate(base, 'HOLD_HISTORY_MISSING');
  }

  const route = reservation.routingDecision;
  if (!route || reservation.routingDecisionId !== route.id) {
    return indeterminate(base, 'RESERVATION_LINEAGE_MISSING');
  }
  const routeLineageValid =
    route.workspaceId === reservation.workspaceId &&
    route.conversation.workspaceId === reservation.workspaceId &&
    route.userMessage.workspaceId === reservation.workspaceId &&
    route.userMessage.conversationId === route.conversationId &&
    route.userMessage.id === route.userMessageId &&
    route.userMessage.role === AiMessageRole.USER &&
    route.userMessage.authorUserId === route.conversation.ownerUserId;
  if (!routeLineageValid) return indeterminate(base, 'ROUTING_LINEAGE_INVALID');

  const runs = route.runs;
  const runLineageValid = runs.every(
    (run) =>
      run.conversationId === route.conversationId &&
      run.groundedContextId === (route.groundedContext?.id ?? null) &&
      run.knowledgeActionType === null &&
      run.requestedByUserId === route.conversation.ownerUserId &&
      run.routingDecisionId === route.id &&
      run.userMessageId === route.userMessageId &&
      run.workspaceId === reservation.workspaceId,
  );
  if (!runLineageValid) return indeterminate(base, 'ROUTING_LINEAGE_INVALID');

  const orchestrations = await loadRouteOrchestrations(prisma, reservation);
  if (!isMultiMode(route.resolvedMode)) {
    if (route.resolvedMode !== AiOrchestrationMode.FAST) {
      return indeterminate(base, 'EXECUTION_MODE_INVALID');
    }
    if (
      runs.length > 1 ||
      runs.some((run) => run.orchestrationId !== null) ||
      orchestrations.length > 0
    ) {
      return indeterminate(base, 'FAST_RUN_LINEAGE_INVALID');
    }
  } else {
    const orchestration = orchestrations[0];
    if (
      orchestrations.length !== 1 ||
      !orchestration ||
      orchestration.createdByUserId !== route.conversation.ownerUserId ||
      orchestration.groundedContextId !== route.groundedContext?.id ||
      orchestration.mode !== route.resolvedMode ||
      !TERMINAL_ORCHESTRATION_STATUSES.has(orchestration.status) ||
      runs.some((run) => run.orchestrationId !== orchestration.id)
    ) {
      return indeterminate(base, 'MULTI_ORCHESTRATION_LINEAGE_INVALID');
    }
  }

  if (runs.some((run) => !isTerminalRunStatus(run.status))) {
    return indeterminate(base, 'EXECUTION_NOT_TERMINAL');
  }
  if (runs.some((run) => run.providerAttempted === null)) {
    return indeterminate(base, 'RUN_ATTEMPT_STATE_UNKNOWN');
  }
  if (runs.some((run) => run.providerAttempted === false && run.estimatedCostUsd !== null)) {
    return indeterminate(base, 'RUN_ACCOUNTING_STATE_INVALID');
  }

  if (base.providerAttemptCount === 0) {
    if (reservation.holdReason !== AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED) {
      return indeterminate(base, 'HOLD_REASON_EVIDENCE_CONFLICT');
    }
    // Every network call is preceded by a durable AiRun providerAttempted=true update.
    // With a terminal valid lineage, no true attempt therefore proves zero attempts.
    return Object.freeze({ ...base, classification: 'RESOLVABLE_RELEASE_ZERO_ATTEMPT' as const });
  }

  const knownCosts = runs
    .filter((run) => run.providerAttempted === true)
    .map((run) => fixedUsd(run.estimatedCostUsd));
  const known = knownCosts.filter((cost): cost is FixedPrecisionUsd => cost !== null);
  if (known.length !== knownCosts.length) {
    return Object.freeze({
      ...base,
      classification: 'BLOCKED_UNKNOWN_COST' as const,
      knownPartialCostUsd: known.length > 0 ? sumLanguageModelCostUsd(known) : null,
    });
  }
  const knownAccountedCostUsd = sumLanguageModelCostUsd(known);
  if (compareFixedPrecisionUsd(knownAccountedCostUsd, base.reservation.reservedAmountUsd) > 0) {
    return Object.freeze({
      ...base,
      classification: 'BLOCKED_OVERRUN' as const,
      knownAccountedCostUsd,
    });
  }
  return Object.freeze({
    ...base,
    classification: 'RESOLVABLE_SETTLE_KNOWN_COST' as const,
    knownAccountedCostUsd,
  });
}

/**
 * Lists every currently HELD reservation in exactly one workspace. Each item
 * is classified through the same authoritative inspection used by controlled
 * resolution, but this listing performs no mutation and invokes no provider.
 */
export async function listWorkspaceAiBudgetHolds(
  prisma: PrismaClient,
  operatorUserId: string,
  workspaceId: string,
): Promise<readonly WorkspaceAiBudgetHoldCandidate[]> {
  if (!validUuid(operatorUserId) || !validUuid(workspaceId)) {
    throw new AiBudgetHoldResolutionValidationError(
      'The AI budget hold operations input is invalid.',
      'budget_hold_resolution_invalid',
    );
  }
  await requireAiBudgetAdministrationAccess(prisma, operatorUserId, workspaceId);

  const reservations = await prisma.aiBudgetReservation.findMany({
    where: { status: AiBudgetReservationStatus.HELD, workspaceId },
    select: {
      id: true,
      routingDecision: { select: { userMessage: { select: { content: true } } } },
    },
    orderBy: [{ heldAt: 'desc' }, { id: 'asc' }],
  });
  const candidates: WorkspaceAiBudgetHoldCandidate[] = [];
  for (const reservation of reservations) {
    const inspection = await inspectAiBudgetHoldResolution(prisma, {
      operatorUserId,
      reservationId: reservation.id,
      workspaceId,
    });
    // Concurrent resolution can make a formerly HELD row terminal after the
    // list query. Never present terminal state as a current hold.
    if (inspection.reservation.status !== AiBudgetReservationStatus.HELD) continue;
    candidates.push(
      projectWorkspaceAiBudgetHold(
        inspection,
        requestPreview(reservation.routingDecision?.userMessage.content ?? 'Request unavailable'),
      ),
    );
  }
  return Object.freeze(candidates);
}

/**
 * Resolves a hold only from a fresh authoritative inspection. Callers cannot
 * choose an outcome or submit any claimed cost; terminal primitives retain
 * their own database locking and idempotency protections.
 */
export async function resolveAiBudgetHold(
  prisma: PrismaClient,
  input: AiBudgetHoldResolutionInput,
): Promise<ResolveAiBudgetHoldResult> {
  const inspection = await inspectAiBudgetHoldResolution(prisma, input);
  if (inspection.classification === 'RESOLVABLE_RELEASE_ZERO_ATTEMPT') {
    try {
      await releaseAiBudgetReservation(prisma, {
        actorUserId: input.operatorUserId,
        reservationId: input.reservationId,
        workspaceId: input.workspaceId,
      });
      return Object.freeze({
        action: 'RELEASED' as const,
        inspection: await inspectAiBudgetHoldResolution(prisma, input),
      });
    } catch (error) {
      if (!(error instanceof AiBudgetStateError)) throw error;
    }
  } else if (inspection.classification === 'RESOLVABLE_SETTLE_KNOWN_COST') {
    try {
      await settleAiBudgetReservation(prisma, {
        actualCostUsd: inspection.knownAccountedCostUsd,
        actorUserId: input.operatorUserId,
        reservationId: input.reservationId,
        workspaceId: input.workspaceId,
      });
      return Object.freeze({
        action: 'SETTLED' as const,
        inspection: await inspectAiBudgetHoldResolution(prisma, input),
      });
    } catch (error) {
      if (!(error instanceof AiBudgetStateError)) throw error;
    }
  } else {
    return Object.freeze({ action: 'NO_MUTATION' as const, inspection });
  }

  // A concurrent resolver may have completed the controlled transition. A
  // fresh read preserves idempotency without ever applying a second ledger debit.
  return Object.freeze({
    action: 'NO_MUTATION' as const,
    inspection: await inspectAiBudgetHoldResolution(prisma, input),
  });
}
