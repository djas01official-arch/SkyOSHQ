import {
  AiBudgetReservationHoldReason,
  AiBudgetReservationStatus,
  AiOrchestrationStatus,
  AiRunStatus,
  type AiBudgetReservation,
  type AiRun,
  type PrismaClient,
} from '../generated/client/client';
import {
  evaluateAiBudgetContinuation,
  evaluateAiBudgetSettlement,
  inspectAiBudgetContinuationAccounting,
  type AiBudgetContinuationDecision,
  type AiBudgetRunCostObservation,
  type AiBudgetSettlementDecision,
} from '../../services/ai/ai-budget-execution-guard';
import type { AiCostRunEstimate } from '../../services/ai/ai-cost-estimator';
import type { AiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
import type { AiInputTokenMeasurementPolicy } from '../../services/ai/ai-budget-runtime-config';
import {
  getAiOrchestrationPolicy,
  type AiOrchestrationModeKey,
  type AiOrchestrationRoleKey,
} from '../../services/ai/ai-orchestration-policy';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  AiBudgetPersistenceError,
  AiBudgetStateError,
  getAiBudgetSnapshotForConsumption,
  holdAiBudgetReservationForConsumption,
  releaseAiBudgetReservationForConsumption,
  settleAiBudgetReservationForConsumption,
} from './ai-budget';
import { AiRoutingDecisionError, getAiRoutingDecisionById } from './ai-routing-decisions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_ORCHESTRATION_STATUSES: ReadonlySet<AiOrchestrationStatus> = new Set([
  AiOrchestrationStatus.SUCCEEDED,
  AiOrchestrationStatus.PARTIALLY_SUCCEEDED,
  AiOrchestrationStatus.FAILED,
  AiOrchestrationStatus.CANCELLED,
]);

type AccountingRun = Pick<
  AiRun,
  'createdAt' | 'estimatedCostUsd' | 'id' | 'orchestrationStep' | 'providerAttempted' | 'status'
>;

export type ReconcileAiBudgetReservationInput = Readonly<{
  actorUserId: string;
  executionAbortedBeforeProvider?: boolean;
  reservationId: string;
  routingDecisionId: string;
  workspaceId: string;
}>;

export type AiBudgetExecutionContext = Readonly<{
  executionPlan?: AiExecutionCostPlan;
  inputTokenMeasurement?: AiInputTokenMeasurementPolicy;
  pricingEffectiveAt?: string;
  reservationId: string;
  reservedAmountUsd: FixedPrecisionUsd;
  routingDecisionId: string;
  runEstimates: readonly AiCostRunEstimate[];
}>;

export type AiBudgetPlannedRun = Readonly<{
  modelKey: string;
  modelVersion: string;
  providerKey: string;
  role: AiOrchestrationRoleKey;
  step: number;
}>;

export type AiBudgetContinuationResult = Readonly<{
  decision: AiBudgetContinuationDecision;
  observations: readonly AiBudgetRunCostObservation[];
}>;

export type AiBudgetReconciliationResult = Readonly<{
  alreadyTerminal: boolean;
  decision: AiBudgetSettlementDecision;
  observations: readonly AiBudgetRunCostObservation[];
  outcome: 'SETTLED' | 'RELEASED' | 'HELD';
  reservation: Readonly<{
    id: string;
    heldAt: Date | null;
    holdReason: AiBudgetReservationHoldReason | null;
    reservedAmountUsd: FixedPrecisionUsd;
    settledAmountUsd: FixedPrecisionUsd | null;
    status: AiBudgetReservationStatus;
  }>;
}>;

export class AiBudgetAccountingError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const PROVIDER_IDENTITY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function providerIdentity(value: string): string {
  if (!PROVIDER_IDENTITY_PATTERN.test(value)) {
    throw new AiBudgetAccountingError(
      'The AI budget execution provider identity is invalid.',
      'budget_execution_context_invalid',
    );
  }
  return value;
}

function assertEstimateMatchesRun(
  estimate: AiCostRunEstimate | undefined,
  plannedRun: AiBudgetPlannedRun,
): asserts estimate is AiCostRunEstimate & { estimatedCostUsd: FixedPrecisionUsd } {
  providerIdentity(plannedRun.providerKey);
  providerIdentity(plannedRun.modelKey);
  providerIdentity(plannedRun.modelVersion);
  if (
    !estimate ||
    !Number.isSafeInteger(plannedRun.step) ||
    plannedRun.step < 0 ||
    estimate.providerKey !== plannedRun.providerKey ||
    estimate.modelKey !== plannedRun.modelKey ||
    estimate.modelVersion !== plannedRun.modelVersion ||
    estimate.role !== plannedRun.role ||
    !estimate.pricingKnown ||
    estimate.estimatedCostUsd === null ||
    !isFixedPrecisionUsd(estimate.estimatedCostUsd)
  ) {
    throw new AiBudgetAccountingError(
      'The AI budget estimate does not match the provider execution plan.',
      'budget_execution_plan_mismatch',
    );
  }
}

/**
 * Binds the ordered preflight estimate to the exact provider-neutral policy
 * steps that the executor resolved. No pricing is recalculated here.
 */
export function validateAiBudgetExecutionPlan(
  context: AiBudgetExecutionContext,
  mode: Exclude<AiOrchestrationModeKey, 'FAST'>,
  plannedRuns: readonly AiBudgetPlannedRun[],
): void {
  identifier(context.routingDecisionId);
  identifier(context.reservationId);
  if (!isFixedPrecisionUsd(context.reservedAmountUsd)) {
    throw new AiBudgetAccountingError(
      'The AI budget execution reservation amount is invalid.',
      'budget_execution_context_invalid',
    );
  }
  const hasDynamicMeasurementContext =
    context.executionPlan !== undefined ||
    context.inputTokenMeasurement !== undefined ||
    context.pricingEffectiveAt !== undefined;
  if (
    hasDynamicMeasurementContext &&
    (!context.executionPlan ||
      !context.inputTokenMeasurement ||
      !['DISABLED', 'WHEN_AVAILABLE', 'REQUIRED'].includes(context.inputTokenMeasurement) ||
      typeof context.pricingEffectiveAt !== 'string' ||
      !Number.isFinite(Date.parse(context.pricingEffectiveAt)) ||
      new Date(context.pricingEffectiveAt).toISOString() !== context.pricingEffectiveAt ||
      context.executionPlan.mode !== mode)
  ) {
    throw new AiBudgetAccountingError(
      'The dynamic input measurement execution context is invalid.',
      'budget_execution_context_invalid',
    );
  }
  const policy = getAiOrchestrationPolicy(mode);
  if (
    plannedRuns.length !== policy.steps.length ||
    context.runEstimates.length !== policy.steps.length
  ) {
    throw new AiBudgetAccountingError(
      'The AI budget estimate does not match the orchestration policy.',
      'budget_execution_plan_mismatch',
    );
  }
  for (const [step, plannedRun] of plannedRuns.entries()) {
    if (plannedRun.step !== step || plannedRun.role !== policy.steps[step]?.role) {
      throw new AiBudgetAccountingError(
        'The AI budget estimate step does not match the orchestration policy.',
        'budget_execution_plan_mismatch',
      );
    }
    assertEstimateMatchesRun(context.runEstimates[step], plannedRun);
    const executionPlanRun = context.executionPlan?.runs[step];
    if (
      context.executionPlan &&
      (!executionPlanRun ||
        context.executionPlan.runs.length !== plannedRuns.length ||
        executionPlanRun.providerKey !== plannedRun.providerKey ||
        executionPlanRun.modelKey !== plannedRun.modelKey ||
        executionPlanRun.modelVersion !== plannedRun.modelVersion ||
        executionPlanRun.role !== plannedRun.role ||
        executionPlanRun.inputTokens !== context.runEstimates[step]?.assumedInputTokens ||
        executionPlanRun.outputTokens !== context.runEstimates[step]?.assumedOutputTokens)
    ) {
      throw new AiBudgetAccountingError(
        'The dynamic input measurement plan does not match the preflight estimate.',
        'budget_execution_plan_mismatch',
      );
    }
  }
}

/**
 * Reads the authoritative active reservation and every linked run immediately
 * before one provider execution. This function never mutates financial state.
 */
export async function checkAiBudgetContinuation(
  prisma: PrismaClient,
  input: Readonly<{
    actorUserId: string;
    context: AiBudgetExecutionContext;
    mode: Exclude<AiOrchestrationModeKey, 'FAST'>;
    nextRun: AiBudgetPlannedRun;
    resolveNextRunEstimate?: (plannedEstimate: AiCostRunEstimate) => Promise<AiCostRunEstimate>;
    workspaceId: string;
  }>,
): Promise<AiBudgetContinuationResult> {
  const estimate = input.context.runEstimates[input.nextRun.step];
  assertEstimateMatchesRun(estimate, input.nextRun);
  let routingDecision;
  try {
    routingDecision = await getAiRoutingDecisionById(
      prisma,
      identifier(input.actorUserId),
      identifier(input.workspaceId),
      identifier(input.context.routingDecisionId),
    );
  } catch (error) {
    if (!(error instanceof AiRoutingDecisionError)) throw error;
    throw new AiBudgetAccountingError(
      'The AI budget execution routing decision is unavailable.',
      'budget_execution_context_invalid',
    );
  }
  if (routingDecision.resolvedMode !== input.mode) {
    throw new AiBudgetAccountingError(
      'The AI budget execution mode does not match its routing decision.',
      'budget_execution_context_invalid',
    );
  }
  const reservation = await prisma.aiBudgetReservation.findFirst({
    where: {
      id: identifier(input.context.reservationId),
      routingDecisionId: routingDecision.id,
      workspaceId: routingDecision.workspaceId,
    },
  });
  if (!reservation) {
    throw new AiBudgetAccountingError(
      'The AI budget execution reservation does not match this routing decision.',
      'budget_execution_reservation_invalid',
    );
  }
  try {
    await getAiBudgetSnapshotForConsumption(
      prisma,
      input.actorUserId,
      input.workspaceId,
      reservation.accountId,
    );
  } catch (error) {
    if (!(error instanceof AiBudgetPersistenceError)) throw error;
    throw new AiBudgetAccountingError(
      'The AI budget execution reservation is unavailable.',
      'budget_execution_reservation_invalid',
    );
  }
  const reservedAmountUsd = money(reservation.reservedAmountUsd);
  if (
    reservation.status !== AiBudgetReservationStatus.RESERVED ||
    reservedAmountUsd === null ||
    reservedAmountUsd !== input.context.reservedAmountUsd
  ) {
    throw new AiBudgetAccountingError(
      'The authoritative AI budget reservation is inactive or does not match the execution.',
      'budget_execution_reservation_invalid',
    );
  }
  const runs = await loadAccountingRuns(prisma, input.workspaceId, routingDecision.id);
  const observations = Object.freeze(runs.map(observationFromRun));
  const accounting = inspectAiBudgetContinuationAccounting(observations, reservedAmountUsd);
  let nextRunEstimate: AiCostRunEstimate = estimate;
  if (accounting.status === 'READY' && input.resolveNextRunEstimate) {
    nextRunEstimate = await input.resolveNextRunEstimate(estimate);
    assertEstimateMatchesRun(nextRunEstimate, input.nextRun);
    if (
      nextRunEstimate.assumedInputTokens < estimate.assumedInputTokens ||
      nextRunEstimate.assumedOutputTokens !== estimate.assumedOutputTokens ||
      compareFixedPrecisionUsd(nextRunEstimate.estimatedCostUsd, estimate.estimatedCostUsd) < 0
    ) {
      throw new AiBudgetAccountingError(
        'The adjusted AI budget estimate does not preserve the planned run limits.',
        'budget_execution_plan_mismatch',
      );
    }
  }
  assertEstimateMatchesRun(nextRunEstimate, input.nextRun);
  const decision = evaluateAiBudgetContinuation({
    completedRuns: observations,
    nextPlannedRunEstimateUsd: nextRunEstimate.estimatedCostUsd,
    reservedAmountUsd,
  });
  return Object.freeze({ decision, observations });
}

function identifier(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AiBudgetAccountingError(
      'The AI budget accounting identity is invalid.',
      'budget_accounting_input_invalid',
    );
  }
  return value;
}

function money(value: { toFixed(decimalPlaces: number): string } | null): FixedPrecisionUsd | null {
  if (value === null) return null;
  const formatted = value.toFixed(12);
  if (!isFixedPrecisionUsd(formatted)) {
    throw new AiBudgetAccountingError(
      'The persisted AI budget accounting amount is invalid.',
      'budget_accounting_state_invalid',
    );
  }
  return formatted;
}

function observationFromRun(run: AccountingRun): AiBudgetRunCostObservation {
  const accountedCostUsd = money(run.estimatedCostUsd);
  if (run.providerAttempted === false && accountedCostUsd !== null) {
    throw new AiBudgetAccountingError(
      'A non-attempted AI run cannot contain accounted provider cost.',
      'budget_accounting_state_invalid',
    );
  }
  // Historical null attempt state is conservatively treated as unknown/attempted.
  const providerAttempted = run.providerAttempted !== false;
  return Object.freeze({
    actualCostUsd: accountedCostUsd,
    providerAttempted,
    runId: run.id,
  });
}

async function loadAccountingRuns(
  prisma: PrismaClient,
  workspaceId: string,
  routingDecisionId: string,
): Promise<readonly AccountingRun[]> {
  const runs = await prisma.aiRun.findMany({
    where: { routingDecisionId, workspaceId },
    orderBy: [{ orchestrationStep: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      createdAt: true,
      estimatedCostUsd: true,
      id: true,
      orchestrationStep: true,
      providerAttempted: true,
      status: true,
    },
  });
  if (new Set(runs.map(({ id }) => id)).size !== runs.length) {
    throw new AiBudgetAccountingError(
      'Duplicate AI run accounting observations are not permitted.',
      'budget_accounting_duplicate_run',
    );
  }
  return runs;
}

export async function loadAiBudgetRunCostObservations(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  routingDecisionId: string,
): Promise<readonly AiBudgetRunCostObservation[]> {
  await getAiRoutingDecisionById(
    prisma,
    identifier(actorUserId),
    identifier(workspaceId),
    identifier(routingDecisionId),
  );
  const runs = await loadAccountingRuns(prisma, workspaceId, routingDecisionId);
  return Object.freeze(runs.map(observationFromRun));
}

function reservationView(reservation: AiBudgetReservation) {
  const reservedAmountUsd = money(reservation.reservedAmountUsd);
  if (reservedAmountUsd === null) {
    throw new AiBudgetAccountingError(
      'The persisted AI budget reservation amount is invalid.',
      'budget_accounting_state_invalid',
    );
  }
  return Object.freeze({
    heldAt: reservation.heldAt,
    holdReason: reservation.holdReason,
    id: reservation.id,
    reservedAmountUsd,
    settledAmountUsd: money(reservation.settledAmountUsd),
    status: reservation.status,
  });
}

function holdReasonForDecision(
  decision: Extract<AiBudgetSettlementDecision, { action: 'HOLD' }>,
): AiBudgetReservationHoldReason {
  switch (decision.reason) {
    case 'UNKNOWN_ACTUAL_COST':
      return AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST;
    case 'ACTUAL_COST_OVERRUN':
      return AiBudgetReservationHoldReason.ACTUAL_COST_OVERRUN;
    case 'ACCOUNTING_INCONSISTENT':
      return AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED;
  }
}

function decisionForPersistedHold(
  holdReason: AiBudgetReservationHoldReason | null,
): Extract<AiBudgetSettlementDecision, { action: 'HOLD' }> {
  switch (holdReason) {
    case AiBudgetReservationHoldReason.UNKNOWN_PROVIDER_COST:
      return Object.freeze({
        action: 'HOLD' as const,
        knownActualSpentUsd: null,
        reason: 'UNKNOWN_ACTUAL_COST' as const,
        settledAmountUsd: null,
      });
    case AiBudgetReservationHoldReason.ACTUAL_COST_OVERRUN:
      return Object.freeze({
        action: 'HOLD' as const,
        knownActualSpentUsd: null,
        reason: 'ACTUAL_COST_OVERRUN' as const,
        settledAmountUsd: null,
      });
    case AiBudgetReservationHoldReason.ACCOUNTING_UNRESOLVED:
      return Object.freeze({
        action: 'HOLD' as const,
        knownActualSpentUsd: null,
        reason: 'ACCOUNTING_INCONSISTENT' as const,
        settledAmountUsd: null,
      });
    default:
      throw new AiBudgetAccountingError(
        'The held AI budget reservation does not contain its immutable hold reason.',
        'budget_accounting_state_invalid',
      );
  }
}

function terminalReadBack(
  reservation: AiBudgetReservation,
  observations: readonly AiBudgetRunCostObservation[],
  decision: AiBudgetSettlementDecision,
): AiBudgetReconciliationResult | null {
  const view = reservationView(reservation);
  if (reservation.status === AiBudgetReservationStatus.HELD) {
    return Object.freeze({
      alreadyTerminal: true,
      decision: decisionForPersistedHold(view.holdReason),
      observations,
      outcome: 'HELD' as const,
      reservation: view,
    });
  }
  if (reservation.status === AiBudgetReservationStatus.SETTLED) {
    if (
      view.settledAmountUsd === null ||
      decision.action !== 'SETTLE' ||
      decision.settledAmountUsd !== view.settledAmountUsd
    ) {
      throw new AiBudgetAccountingError(
        'The settled AI budget reservation does not match current accounting evidence.',
        'budget_accounting_state_invalid',
      );
    }
    return Object.freeze({
      alreadyTerminal: true,
      decision,
      observations,
      outcome: 'SETTLED' as const,
      reservation: view,
    });
  }
  if (reservation.status === AiBudgetReservationStatus.RELEASED) {
    if (decision.action !== 'RELEASE') {
      throw new AiBudgetAccountingError(
        'The released AI budget reservation does not match current accounting evidence.',
        'budget_accounting_state_invalid',
      );
    }
    return Object.freeze({
      alreadyTerminal: true,
      decision,
      observations,
      outcome: 'RELEASED' as const,
      reservation: view,
    });
  }
  return null;
}

async function executionIsTerminal(
  prisma: PrismaClient,
  routingDecision: Awaited<ReturnType<typeof getAiRoutingDecisionById>>,
  runs: readonly AccountingRun[],
  executionAbortedBeforeProvider: boolean,
): Promise<boolean> {
  const runsAreTerminal = runs.every(({ status }) => status !== AiRunStatus.PROCESSING);
  const orchestrations = await prisma.aiOrchestration.findMany({
    where: {
      conversationId: routingDecision.conversationId,
      mode: routingDecision.resolvedMode,
      userMessageId: routingDecision.userMessageId,
      workspaceId: routingDecision.workspaceId,
    },
    select: { status: true },
  });
  if (executionAbortedBeforeProvider && runs.length === 0 && orchestrations.length === 0) {
    return true;
  }
  if (routingDecision.resolvedMode === 'FAST') return runs.length > 0 && runsAreTerminal;
  return (
    orchestrations.length === 1 &&
    TERMINAL_ORCHESTRATION_STATUSES.has(orchestrations[0]!.status) &&
    runsAreTerminal
  );
}

async function currentReservation(
  prisma: PrismaClient,
  accountId: string,
  input: ReconcileAiBudgetReservationInput,
): Promise<AiBudgetReservation> {
  const reservation = await prisma.aiBudgetReservation.findFirst({
    where: {
      accountId,
      id: identifier(input.reservationId),
      routingDecisionId: identifier(input.routingDecisionId),
      workspaceId: identifier(input.workspaceId),
    },
  });
  if (!reservation) {
    throw new AiBudgetAccountingError(
      'The AI budget reservation does not match this routing decision and workspace.',
      'budget_accounting_reservation_not_found',
    );
  }
  return reservation;
}

/**
 * Reconciles every durably linked Chat run for one routing decision. Persisted
 * estimatedCostUsd is treated as the known accounted telemetry cost, not as a
 * provider invoice. HOLD durably blocks the original reservation for later
 * financial review without creating a ledger entry.
 */
export async function reconcileAiBudgetReservation(
  prisma: PrismaClient,
  input: ReconcileAiBudgetReservationInput,
): Promise<AiBudgetReconciliationResult> {
  const routingDecision = await getAiRoutingDecisionById(
    prisma,
    identifier(input.actorUserId),
    identifier(input.workspaceId),
    identifier(input.routingDecisionId),
  );
  const account = await prisma.aiBudgetAccount.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!account) {
    throw new AiBudgetAccountingError(
      'The AI budget reservation does not match this routing decision and workspace.',
      'budget_accounting_reservation_not_found',
    );
  }
  await getAiBudgetSnapshotForConsumption(prisma, input.actorUserId, input.workspaceId, account.id);
  let reservation = await currentReservation(prisma, account.id, input);
  const runs = await loadAccountingRuns(prisma, input.workspaceId, input.routingDecisionId);
  const observations = Object.freeze(runs.map(observationFromRun));
  const decision = evaluateAiBudgetSettlement({
    completedRuns: observations,
    executionTerminal: await executionIsTerminal(
      prisma,
      routingDecision,
      runs,
      input.executionAbortedBeforeProvider === true,
    ),
    providerExecutionOccurred: observations.some(({ providerAttempted }) => providerAttempted),
    reservedAmountUsd: reservationView(reservation).reservedAmountUsd,
  });
  const existing = terminalReadBack(reservation, observations, decision);
  if (existing) return existing;
  if (decision.action === 'HOLD') {
    reservation = await holdAiBudgetReservationForConsumption(prisma, {
      actorUserId: input.actorUserId,
      holdReason: holdReasonForDecision(decision),
      reservationId: reservation.id,
      routingDecisionId: input.routingDecisionId,
      workspaceId: input.workspaceId,
    });
    return Object.freeze({
      alreadyTerminal: false,
      decision,
      observations,
      outcome: 'HELD' as const,
      reservation: reservationView(reservation),
    });
  }

  try {
    reservation =
      decision.action === 'SETTLE'
        ? await settleAiBudgetReservationForConsumption(prisma, {
            actorUserId: input.actorUserId,
            actualCostUsd: decision.settledAmountUsd,
            reservationId: reservation.id,
            routingDecisionId: input.routingDecisionId,
            workspaceId: input.workspaceId,
          })
        : await releaseAiBudgetReservationForConsumption(prisma, {
            actorUserId: input.actorUserId,
            reservationId: reservation.id,
            routingDecisionId: input.routingDecisionId,
            workspaceId: input.workspaceId,
          });
  } catch (error) {
    if (!(error instanceof AiBudgetStateError)) throw error;
    reservation = await currentReservation(prisma, account.id, input);
    const readBack = terminalReadBack(reservation, observations, decision);
    if (readBack) return readBack;
    throw error;
  }
  return Object.freeze({
    alreadyTerminal: false,
    decision,
    observations,
    outcome: decision.action === 'SETTLE' ? ('SETTLED' as const) : ('RELEASED' as const),
    reservation: reservationView(reservation),
  });
}
