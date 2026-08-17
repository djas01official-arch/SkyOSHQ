import {
  AiBudgetLedgerEntryType,
  AiBudgetExecutionClaimStatus,
  AiBudgetReservationStatus,
  AiMessageRole,
  AiOrchestrationMode,
  type Prisma,
  type AiOrchestrationStatus,
  type PrismaClient,
} from '../generated/client/client';
import {
  KnowledgeAuthorizationError,
  requireKnowledgeWorkspaceAccess,
} from '../knowledge/knowledge-documents';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  isFixedPrecisionUsd,
  sumLanguageModelCostUsd,
} from '../../services/ai/language-model-pricing';
import { requireAiAccess } from './ai-conversations';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INPUT_KEYS = ['actorUserId', 'executionClaimId', 'workspaceId'] as const;

export type AiBudgetExecutionRecoveryInput = Readonly<{
  actorUserId: string;
  executionClaimId: string;
  workspaceId: string;
}>;

export type AiBudgetExecutionRecoveryClassification =
  | 'NOT_STARTED'
  | 'ALREADY_TERMINAL'
  | 'ZERO_ATTEMPT_PROVEN'
  | 'ATTEMPTED_KNOWN_COST'
  | 'ATTEMPTED_UNKNOWN_COST'
  | 'TERMINAL_FINANCIAL_STATE'
  | 'INDETERMINATE';

export type AiBudgetExecutionRecoveryIndeterminateReason =
  | 'EXECUTION_LINEAGE_MISMATCH'
  | 'EXECUTION_MODE_INVALID'
  | 'FAST_RUN_LINEAGE_INVALID'
  | 'MULTI_ORCHESTRATION_LINEAGE_INVALID'
  | 'RUN_ACCOUNTING_STATE_INVALID'
  | 'RUN_ATTEMPT_STATE_UNKNOWN';

type AiBudgetExecutionRecoveryEvidence = Readonly<{
  claimId: string;
  claimStatus: AiBudgetExecutionClaimStatus;
  knownAttemptedRunCount: number;
  knownObservedCostUsd: FixedPrecisionUsd | null;
  orchestration: Readonly<{ id: string; status: AiOrchestrationStatus }> | null;
  providerAttemptCount: number;
  reservation: Readonly<{
    id: string;
    reservedAmountUsd: FixedPrecisionUsd | null;
    settlementLedgerEntry: Readonly<{
      amountUsd: FixedPrecisionUsd | null;
      id: string;
      type: AiBudgetLedgerEntryType;
    }> | null;
    settledAmountUsd: FixedPrecisionUsd | null;
    status: AiBudgetReservationStatus;
  }>;
  resolvedMode: AiOrchestrationMode;
  routingDecisionId: string;
  runCount: number;
  unknownCostAttemptedRunCount: number;
}>;

export type AiBudgetExecutionRecoveryInspection =
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{ classification: 'NOT_STARTED'; safeRecoveryClass: 'TERMINAL' }>)
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{ classification: 'ALREADY_TERMINAL'; safeRecoveryClass: 'TERMINAL' }>)
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{
        classification: 'ZERO_ATTEMPT_PROVEN';
        safeRecoveryClass: 'ZERO_ATTEMPT';
      }>)
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{
        classification: 'ATTEMPTED_KNOWN_COST';
        knownAccountedCostUsd: FixedPrecisionUsd;
        safeRecoveryClass: 'KNOWN_COST';
      }>)
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{
        classification: 'ATTEMPTED_UNKNOWN_COST';
        knownPartialCostUsd: FixedPrecisionUsd | null;
        safeRecoveryClass: 'UNKNOWN_COST';
      }>)
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{
        classification: 'TERMINAL_FINANCIAL_STATE';
        safeRecoveryClass: 'TERMINAL';
      }>)
  | (AiBudgetExecutionRecoveryEvidence &
      Readonly<{
        classification: 'INDETERMINATE';
        reason: AiBudgetExecutionRecoveryIndeterminateReason;
        safeRecoveryClass: 'TERMINAL';
      }>);

export class AiBudgetExecutionRecoveryError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetExecutionRecoveryNotFoundError extends AiBudgetExecutionRecoveryError {}
export class AiBudgetExecutionRecoveryValidationError extends AiBudgetExecutionRecoveryError {}
export class AiBudgetExecutionRecoveryOperationsAuthorizationError extends AiBudgetExecutionRecoveryError {}

const RECOVERY_CLAIM_INCLUDE = {
  confirmation: true,
  reservation: { include: { settlementLedgerEntry: true } },
  routingDecision: {
    include: {
      conversation: true,
      groundedContext: { include: { orchestrations: true } },
      runs: { include: { orchestration: true } },
      userMessage: true,
    },
  },
} satisfies Prisma.AiBudgetExecutionClaimInclude;

type RecoveryClaim = Prisma.AiBudgetExecutionClaimGetPayload<{
  include: typeof RECOVERY_CLAIM_INCLUDE;
}>;

export type WorkspaceAiBudgetExecutionRecoveryCandidate = Readonly<{
  classification: AiBudgetExecutionRecoveryClassification;
  conversationId: string;
  executionClaimId: string;
  indeterminateReason: AiBudgetExecutionRecoveryIndeterminateReason | null;
  knownAccountedCostUsd: FixedPrecisionUsd | null;
  knownCostAttemptCount: number;
  orchestration: Readonly<{ status: AiOrchestrationStatus }> | null;
  providerAttemptCount: number;
  requestPreview: string;
  reservation: Readonly<{
    reservedAmountUsd: FixedPrecisionUsd | null;
    status: AiBudgetReservationStatus;
  }>;
  resolvedMode: AiOrchestrationMode;
  routingDecisionId: string;
  startedAt: Date | null;
  unknownCostAttemptCount: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validateInput(input: AiBudgetExecutionRecoveryInput): void {
  if (!isRecord(input)) {
    throw new AiBudgetExecutionRecoveryValidationError(
      'The AI budget execution recovery inspection input is invalid.',
      'budget_execution_recovery_invalid',
    );
  }
  const keys = Object.keys(input);
  if (
    keys.length !== INPUT_KEYS.length ||
    !keys.every((key) => INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number])) ||
    !validUuid(input.actorUserId) ||
    !validUuid(input.executionClaimId) ||
    !validUuid(input.workspaceId)
  ) {
    throw new AiBudgetExecutionRecoveryValidationError(
      'The AI budget execution recovery inspection input is invalid.',
      'budget_execution_recovery_invalid',
    );
  }
}

function fixedUsd(
  value: { toFixed: (digits?: number) => string } | null,
): FixedPrecisionUsd | null {
  if (value === null) return null;
  const formatted = value.toFixed(12);
  return isFixedPrecisionUsd(formatted) ? formatted : null;
}

function isMultiMode(mode: AiOrchestrationMode): boolean {
  return (
    mode === AiOrchestrationMode.BALANCED ||
    mode === AiOrchestrationMode.DEEP ||
    mode === AiOrchestrationMode.CRITICAL
  );
}

export async function requireAiBudgetExecutionRecoveryOperationsAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
    if (
      !workspaceRoleGrantsPermission(access.role, 'ai.use') ||
      !workspaceRoleGrantsPermission(access.role, 'workspace.members.read')
    ) {
      throw new AiBudgetExecutionRecoveryOperationsAuthorizationError(
        'AI execution recovery operations require workspace administration permissions.',
        'budget_execution_recovery_operations_forbidden',
      );
    }
  } catch (error) {
    if (error instanceof AiBudgetExecutionRecoveryOperationsAuthorizationError) throw error;
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiBudgetExecutionRecoveryOperationsAuthorizationError(
        'AI execution recovery operations require workspace administration permissions.',
        'budget_execution_recovery_operations_forbidden',
      );
    }
    throw error;
  }
}

/**
 * Recovery changes durable financial and execution state, so it uses the
 * existing workspace-administration mutation capability rather than the
 * read-only capability used to inspect recovery candidates.
 */
export async function requireAiBudgetExecutionRecoveryMutationAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
    if (
      !workspaceRoleGrantsPermission(access.role, 'ai.use') ||
      !workspaceRoleGrantsPermission(access.role, 'workspace.members.manage')
    ) {
      throw new AiBudgetExecutionRecoveryOperationsAuthorizationError(
        'AI execution recovery operations require workspace administration permissions.',
        'budget_execution_recovery_operations_forbidden',
      );
    }
  } catch (error) {
    if (error instanceof AiBudgetExecutionRecoveryOperationsAuthorizationError) throw error;
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiBudgetExecutionRecoveryOperationsAuthorizationError(
        'AI execution recovery operations require workspace administration permissions.',
        'budget_execution_recovery_operations_forbidden',
      );
    }
    throw error;
  }
}

function requestPreview(value: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function projectWorkspaceRecoveryCandidate(
  claim: RecoveryClaim,
  inspection: AiBudgetExecutionRecoveryInspection,
): WorkspaceAiBudgetExecutionRecoveryCandidate {
  return Object.freeze({
    classification: inspection.classification,
    conversationId: claim.routingDecision.conversationId,
    executionClaimId: claim.id,
    indeterminateReason: inspection.classification === 'INDETERMINATE' ? inspection.reason : null,
    knownAccountedCostUsd:
      inspection.classification === 'ATTEMPTED_KNOWN_COST'
        ? inspection.knownAccountedCostUsd
        : null,
    knownCostAttemptCount: inspection.knownAttemptedRunCount,
    orchestration: inspection.orchestration
      ? Object.freeze({ status: inspection.orchestration.status })
      : null,
    providerAttemptCount: inspection.providerAttemptCount,
    requestPreview: requestPreview(claim.routingDecision.userMessage.content),
    reservation: Object.freeze({
      reservedAmountUsd: inspection.reservation.reservedAmountUsd,
      status: inspection.reservation.status,
    }),
    resolvedMode: inspection.resolvedMode,
    routingDecisionId: inspection.routingDecisionId,
    startedAt: claim.startedAt,
    unknownCostAttemptCount: inspection.unknownCostAttemptedRunCount,
  });
}

/**
 * Inspects durable recovery evidence only. It deliberately invokes no provider,
 * token counter, cost estimator, or financial/execution mutation.
 */
export async function inspectAiBudgetExecutionRecovery(
  prisma: PrismaClient,
  input: AiBudgetExecutionRecoveryInput,
): Promise<AiBudgetExecutionRecoveryInspection> {
  validateInput(input);
  await requireAiAccess(prisma, input.actorUserId, input.workspaceId);

  const claim = await prisma.aiBudgetExecutionClaim.findFirst({
    where: {
      claimedByUserId: input.actorUserId,
      id: input.executionClaimId,
      workspaceId: input.workspaceId,
    },
    include: RECOVERY_CLAIM_INCLUDE,
  });
  if (!claim) {
    throw new AiBudgetExecutionRecoveryNotFoundError(
      'The AI budget execution claim was not found for this user and workspace.',
      'budget_execution_recovery_not_found',
    );
  }

  return inspectRecoveryClaim(claim);
}

/**
 * Provides administrative read-only inspection for one exact workspace claim.
 * Owner-scoped Chat inspection remains intentionally separate above.
 */
export async function inspectWorkspaceAiBudgetExecutionRecovery(
  prisma: PrismaClient,
  input: AiBudgetExecutionRecoveryInput,
): Promise<AiBudgetExecutionRecoveryInspection> {
  validateInput(input);
  await requireAiBudgetExecutionRecoveryOperationsAccess(
    prisma,
    input.actorUserId,
    input.workspaceId,
  );
  const claim = await prisma.aiBudgetExecutionClaim.findFirst({
    where: { id: input.executionClaimId, workspaceId: input.workspaceId },
    include: RECOVERY_CLAIM_INCLUDE,
  });
  if (!claim) {
    throw new AiBudgetExecutionRecoveryNotFoundError(
      'The AI budget execution claim was not found in this workspace.',
      'budget_execution_recovery_not_found',
    );
  }
  return inspectRecoveryClaim(claim);
}

/** Lists only STARTED workspace claims and projects persisted recovery evidence for operations. */
export async function listWorkspaceAiExecutionRecoveryCandidates(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<readonly WorkspaceAiBudgetExecutionRecoveryCandidate[]> {
  if (!validUuid(actorUserId) || !validUuid(workspaceId)) {
    throw new AiBudgetExecutionRecoveryValidationError(
      'The AI budget execution recovery operations input is invalid.',
      'budget_execution_recovery_invalid',
    );
  }
  await requireAiBudgetExecutionRecoveryOperationsAccess(prisma, actorUserId, workspaceId);
  const claims = await prisma.aiBudgetExecutionClaim.findMany({
    where: { status: AiBudgetExecutionClaimStatus.STARTED, workspaceId },
    include: RECOVERY_CLAIM_INCLUDE,
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  return Object.freeze(
    claims.map((claim) => projectWorkspaceRecoveryCandidate(claim, inspectRecoveryClaim(claim))),
  );
}

/** Shared authoritative persisted-evidence classifier for owner and operations inspection. */
function inspectRecoveryClaim(claim: RecoveryClaim): AiBudgetExecutionRecoveryInspection {
  const { confirmation, reservation, routingDecision } = claim;
  const runs = routingDecision.runs;
  const reservationAmount = fixedUsd(reservation.reservedAmountUsd);
  const settledAmount = fixedUsd(reservation.settledAmountUsd);
  const settlementLedgerEntry = reservation.settlementLedgerEntry
    ? Object.freeze({
        amountUsd: fixedUsd(reservation.settlementLedgerEntry.amountUsd),
        id: reservation.settlementLedgerEntry.id,
        type: reservation.settlementLedgerEntry.type,
      })
    : null;
  const invalidReservationAmount = reservationAmount === null;
  const orchestrationIds = [...new Set(runs.map((run) => run.orchestrationId).filter(Boolean))];
  const routeOrchestrations = routingDecision.groundedContext?.orchestrations ?? [];
  const orchestration = routeOrchestrations[0] ?? null;
  const providerAttemptCount = runs.filter((run) => run.providerAttempted === true).length;
  const knownAttemptedCosts = runs
    .filter((run) => run.providerAttempted === true)
    .map((run) => fixedUsd(run.estimatedCostUsd));
  const knownAttemptedRunCount = knownAttemptedCosts.filter(
    (cost): cost is FixedPrecisionUsd => cost !== null,
  ).length;
  const unknownCostAttemptedRunCount = providerAttemptCount - knownAttemptedRunCount;
  const knownObservedCosts = knownAttemptedCosts.filter(
    (cost): cost is FixedPrecisionUsd => cost !== null,
  );

  const evidence = (overrides: Partial<AiBudgetExecutionRecoveryEvidence> = {}) =>
    Object.freeze({
      claimId: claim.id,
      claimStatus: claim.status,
      knownAttemptedRunCount,
      knownObservedCostUsd:
        knownObservedCosts.length > 0 ? sumLanguageModelCostUsd(knownObservedCosts) : null,
      orchestration: orchestration
        ? Object.freeze({ id: orchestration.id, status: orchestration.status })
        : null,
      providerAttemptCount,
      reservation: Object.freeze({
        id: reservation.id,
        reservedAmountUsd: reservationAmount,
        settlementLedgerEntry,
        settledAmountUsd: settledAmount,
        status: reservation.status,
      }),
      resolvedMode: routingDecision.resolvedMode,
      routingDecisionId: routingDecision.id,
      runCount: runs.length,
      unknownCostAttemptedRunCount,
      ...overrides,
    });

  const lineageValid =
    !invalidReservationAmount &&
    claim.confirmationId === confirmation.id &&
    claim.reservationId === reservation.id &&
    claim.routingDecisionId === routingDecision.id &&
    confirmation.workspaceId === claim.workspaceId &&
    reservation.workspaceId === claim.workspaceId &&
    routingDecision.workspaceId === claim.workspaceId &&
    confirmation.routingDecisionId === routingDecision.id &&
    reservation.routingDecisionId === routingDecision.id &&
    claim.claimedByUserId === confirmation.requestedByUserId &&
    routingDecision.conversation.workspaceId === claim.workspaceId &&
    routingDecision.conversation.ownerUserId === confirmation.requestedByUserId &&
    routingDecision.userMessage.workspaceId === claim.workspaceId &&
    routingDecision.userMessage.conversationId === routingDecision.conversationId &&
    routingDecision.userMessage.authorUserId === confirmation.requestedByUserId &&
    routingDecision.userMessage.role === AiMessageRole.USER;
  if (!lineageValid) {
    return Object.freeze({
      ...evidence(),
      classification: 'INDETERMINATE' as const,
      reason: 'EXECUTION_LINEAGE_MISMATCH' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }

  if (claim.status === AiBudgetExecutionClaimStatus.READY) {
    return Object.freeze({
      ...evidence(),
      classification: 'NOT_STARTED' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }
  if (claim.status === AiBudgetExecutionClaimStatus.FINISHED) {
    return Object.freeze({
      ...evidence(),
      classification: 'ALREADY_TERMINAL' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }

  if (
    reservation.status === AiBudgetReservationStatus.SETTLED ||
    reservation.status === AiBudgetReservationStatus.RELEASED
  ) {
    return Object.freeze({
      ...evidence(),
      classification: 'TERMINAL_FINANCIAL_STATE' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }
  if (reservation.status !== AiBudgetReservationStatus.RESERVED) {
    return Object.freeze({
      ...evidence(),
      classification: 'INDETERMINATE' as const,
      reason: 'EXECUTION_LINEAGE_MISMATCH' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }

  const runLineageValid = runs.every(
    (run) =>
      run.workspaceId === claim.workspaceId &&
      run.conversationId === routingDecision.conversationId &&
      run.userMessageId === routingDecision.userMessageId &&
      run.requestedByUserId === confirmation.requestedByUserId &&
      run.routingDecisionId === routingDecision.id &&
      run.knowledgeActionType === null &&
      (routingDecision.groundedContext === null ||
        run.groundedContextId === routingDecision.groundedContext.id),
  );
  if (!runLineageValid) {
    return Object.freeze({
      ...evidence(),
      classification: 'INDETERMINATE' as const,
      reason: 'EXECUTION_LINEAGE_MISMATCH' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }

  if (!isMultiMode(routingDecision.resolvedMode)) {
    if (routingDecision.resolvedMode !== AiOrchestrationMode.FAST) {
      return Object.freeze({
        ...evidence(),
        classification: 'INDETERMINATE' as const,
        reason: 'EXECUTION_MODE_INVALID' as const,
        safeRecoveryClass: 'TERMINAL' as const,
      });
    }
    if (runs.length > 1 || orchestrationIds.length > 0 || routeOrchestrations.length > 0) {
      return Object.freeze({
        ...evidence(),
        classification: 'INDETERMINATE' as const,
        reason: 'FAST_RUN_LINEAGE_INVALID' as const,
        safeRecoveryClass: 'TERMINAL' as const,
      });
    }
  } else if (
    routeOrchestrations.length > 1 ||
    (runs.length > 0 &&
      (orchestrationIds.length !== 1 ||
        orchestration === null ||
        orchestrationIds[0] !== orchestration.id ||
        !runs.every((run) => run.orchestrationId === orchestration.id))) ||
    (orchestration !== null &&
      (orchestration.workspaceId !== claim.workspaceId ||
        orchestration.conversationId !== routingDecision.conversationId ||
        orchestration.userMessageId !== routingDecision.userMessageId ||
        orchestration.createdByUserId !== confirmation.requestedByUserId ||
        orchestration.mode !== routingDecision.resolvedMode ||
        orchestration.groundedContextId !== routingDecision.groundedContext?.id))
  ) {
    return Object.freeze({
      ...evidence(),
      classification: 'INDETERMINATE' as const,
      reason: 'MULTI_ORCHESTRATION_LINEAGE_INVALID' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }

  if (runs.some((run) => run.providerAttempted === null)) {
    return Object.freeze({
      ...evidence(),
      classification: 'INDETERMINATE' as const,
      reason: 'RUN_ATTEMPT_STATE_UNKNOWN' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }
  if (runs.some((run) => run.providerAttempted === false && run.estimatedCostUsd !== null)) {
    return Object.freeze({
      ...evidence(),
      classification: 'INDETERMINATE' as const,
      reason: 'RUN_ACCOUNTING_STATE_INVALID' as const,
      safeRecoveryClass: 'TERMINAL' as const,
    });
  }
  if (providerAttemptCount === 0) {
    return Object.freeze({
      ...evidence(),
      classification: 'ZERO_ATTEMPT_PROVEN' as const,
      safeRecoveryClass: 'ZERO_ATTEMPT' as const,
    });
  }
  if (unknownCostAttemptedRunCount > 0) {
    const knownPartialCosts = knownAttemptedCosts.filter(
      (cost): cost is FixedPrecisionUsd => cost !== null,
    );
    return Object.freeze({
      ...evidence(),
      classification: 'ATTEMPTED_UNKNOWN_COST' as const,
      knownPartialCostUsd:
        knownPartialCosts.length > 0 ? sumLanguageModelCostUsd(knownPartialCosts) : null,
      safeRecoveryClass: 'UNKNOWN_COST' as const,
    });
  }
  return Object.freeze({
    ...evidence(),
    classification: 'ATTEMPTED_KNOWN_COST' as const,
    knownAccountedCostUsd: sumLanguageModelCostUsd(
      knownAttemptedCosts.filter((cost): cost is FixedPrecisionUsd => cost !== null),
    ),
    safeRecoveryClass: 'KNOWN_COST' as const,
  });
}
