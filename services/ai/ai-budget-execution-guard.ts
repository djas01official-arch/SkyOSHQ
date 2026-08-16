import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  subtractFixedPrecisionUsd,
  sumLanguageModelCostUsd,
  type FixedPrecisionUsd,
} from './language-model-pricing';

export type AiBudgetRunCostObservation = Readonly<{
  actualCostUsd: FixedPrecisionUsd | null;
  providerAttempted: boolean;
  runId: string;
}>;

export type AiBudgetContinuationInput = Readonly<{
  completedRuns: readonly AiBudgetRunCostObservation[];
  nextPlannedRunEstimateUsd: FixedPrecisionUsd;
  reservedAmountUsd: FixedPrecisionUsd;
}>;

export type AiBudgetContinuationDecision =
  | Readonly<{
      decision: 'CONTINUE';
      knownActualSpentUsd: FixedPrecisionUsd;
      nextPlannedRunEstimateUsd: FixedPrecisionUsd;
      reason: 'WITHIN_RESERVED_PLAN';
      remainingReservedUsd: FixedPrecisionUsd;
      reservedAmountUsd: FixedPrecisionUsd;
    }>
  | Readonly<{
      decision: 'STOP';
      knownActualSpentUsd: FixedPrecisionUsd;
      nextPlannedRunEstimateUsd: FixedPrecisionUsd;
      reason: 'RESERVATION_ALREADY_EXHAUSTED' | 'NEXT_PLANNED_RUN_EXCEEDS_REMAINING_RESERVE';
      remainingReservedUsd: FixedPrecisionUsd;
      reservedAmountUsd: FixedPrecisionUsd;
    }>
  | Readonly<{
      decision: 'STOP';
      knownActualSpentUsd: FixedPrecisionUsd;
      nextPlannedRunEstimateUsd: FixedPrecisionUsd;
      reason: 'UNKNOWN_ACTUAL_COST' | 'ACTUAL_COST_OVERRUN';
      remainingReservedUsd: null;
      reservedAmountUsd: FixedPrecisionUsd;
    }>;

export type AiBudgetSettlementInput = Readonly<{
  completedRuns: readonly AiBudgetRunCostObservation[];
  executionTerminal: boolean;
  providerExecutionOccurred: boolean;
  reservedAmountUsd: FixedPrecisionUsd;
}>;

export type AiBudgetSettlementDecision =
  | Readonly<{
      action: 'SETTLE';
      knownActualSpentUsd: FixedPrecisionUsd;
      reason: 'ACTUAL_COST_KNOWN';
      settledAmountUsd: FixedPrecisionUsd;
    }>
  | Readonly<{
      action: 'RELEASE';
      knownActualSpentUsd: FixedPrecisionUsd;
      reason: 'NO_PROVIDER_SPEND';
      settledAmountUsd: null;
    }>
  | Readonly<{
      action: 'HOLD';
      knownActualSpentUsd: FixedPrecisionUsd | null;
      reason: 'UNKNOWN_ACTUAL_COST' | 'ACTUAL_COST_OVERRUN' | 'ACCOUNTING_INCONSISTENT';
      settledAmountUsd: null;
    }>;

export class AiBudgetExecutionGuardValidationError extends Error {
  readonly code = 'budget_execution_guard_input_invalid';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTINUATION_KEYS = [
  'completedRuns',
  'nextPlannedRunEstimateUsd',
  'reservedAmountUsd',
] as const;
const SETTLEMENT_KEYS = [
  'completedRuns',
  'executionTerminal',
  'providerExecutionOccurred',
  'reservedAmountUsd',
] as const;
const OBSERVATION_KEYS = ['actualCostUsd', 'providerAttempted', 'runId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalid(): never {
  throw new AiBudgetExecutionGuardValidationError(
    'The AI budget execution accounting input is invalid.',
  );
}

function validateObservations(value: unknown): readonly AiBudgetRunCostObservation[] {
  if (!Array.isArray(value)) invalid();
  const runIds = new Set<string>();
  for (const observation of value) {
    if (
      !isRecord(observation) ||
      !hasExactKeys(observation, OBSERVATION_KEYS) ||
      typeof observation.runId !== 'string' ||
      !UUID_PATTERN.test(observation.runId) ||
      runIds.has(observation.runId) ||
      typeof observation.providerAttempted !== 'boolean' ||
      (observation.actualCostUsd !== null && !isFixedPrecisionUsd(observation.actualCostUsd)) ||
      (!observation.providerAttempted && observation.actualCostUsd !== null)
    ) {
      invalid();
    }
    runIds.add(observation.runId);
  }
  return value as readonly AiBudgetRunCostObservation[];
}

function knownActualCost(completedRuns: readonly AiBudgetRunCostObservation[]): Readonly<{
  hasUnknownActualCost: boolean;
  knownActualSpentUsd: FixedPrecisionUsd;
}> {
  return Object.freeze({
    hasUnknownActualCost: completedRuns.some(
      ({ actualCostUsd, providerAttempted }) => providerAttempted && actualCostUsd === null,
    ),
    knownActualSpentUsd: sumLanguageModelCostUsd(
      completedRuns.flatMap(({ actualCostUsd }) => (actualCostUsd === null ? [] : [actualCostUsd])),
    ),
  });
}

/**
 * Decides whether the next planned call fits the remaining reservation according
 * to its estimate. CONTINUE does not make the provider call an enforced cost cap.
 */
export function evaluateAiBudgetContinuation(
  input: AiBudgetContinuationInput,
): AiBudgetContinuationDecision {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, CONTINUATION_KEYS) ||
    !isFixedPrecisionUsd(input.reservedAmountUsd) ||
    !isFixedPrecisionUsd(input.nextPlannedRunEstimateUsd)
  ) {
    invalid();
  }
  const completedRuns = validateObservations(input.completedRuns);
  const { hasUnknownActualCost, knownActualSpentUsd } = knownActualCost(completedRuns);
  const common = {
    knownActualSpentUsd,
    nextPlannedRunEstimateUsd: input.nextPlannedRunEstimateUsd,
    reservedAmountUsd: input.reservedAmountUsd,
  } as const;

  if (hasUnknownActualCost) {
    return Object.freeze({
      ...common,
      decision: 'STOP' as const,
      reason: 'UNKNOWN_ACTUAL_COST' as const,
      remainingReservedUsd: null,
    });
  }
  const spentComparison = compareFixedPrecisionUsd(knownActualSpentUsd, input.reservedAmountUsd);
  if (spentComparison > 0) {
    return Object.freeze({
      ...common,
      decision: 'STOP' as const,
      reason: 'ACTUAL_COST_OVERRUN' as const,
      remainingReservedUsd: null,
    });
  }
  const remainingReservedUsd = subtractFixedPrecisionUsd(
    input.reservedAmountUsd,
    knownActualSpentUsd,
  );
  if (spentComparison === 0) {
    return Object.freeze({
      ...common,
      decision: 'STOP' as const,
      reason: 'RESERVATION_ALREADY_EXHAUSTED' as const,
      remainingReservedUsd,
    });
  }
  if (compareFixedPrecisionUsd(input.nextPlannedRunEstimateUsd, remainingReservedUsd) > 0) {
    return Object.freeze({
      ...common,
      decision: 'STOP' as const,
      reason: 'NEXT_PLANNED_RUN_EXCEEDS_REMAINING_RESERVE' as const,
      remainingReservedUsd,
    });
  }
  return Object.freeze({
    ...common,
    decision: 'CONTINUE' as const,
    reason: 'WITHIN_RESERVED_PLAN' as const,
    remainingReservedUsd,
  });
}

/**
 * Produces a terminal accounting action without settling or releasing persistence.
 */
export function evaluateAiBudgetSettlement(
  input: AiBudgetSettlementInput,
): AiBudgetSettlementDecision {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, SETTLEMENT_KEYS) ||
    !isFixedPrecisionUsd(input.reservedAmountUsd) ||
    typeof input.executionTerminal !== 'boolean' ||
    typeof input.providerExecutionOccurred !== 'boolean'
  ) {
    invalid();
  }
  const completedRuns = validateObservations(input.completedRuns);
  const attemptedRunCount = completedRuns.filter(
    ({ providerAttempted }) => providerAttempted,
  ).length;
  const { hasUnknownActualCost, knownActualSpentUsd } = knownActualCost(completedRuns);

  if (!input.executionTerminal || input.providerExecutionOccurred !== attemptedRunCount > 0) {
    return Object.freeze({
      action: 'HOLD' as const,
      knownActualSpentUsd: hasUnknownActualCost ? null : knownActualSpentUsd,
      reason: 'ACCOUNTING_INCONSISTENT' as const,
      settledAmountUsd: null,
    });
  }
  if (hasUnknownActualCost) {
    return Object.freeze({
      action: 'HOLD' as const,
      knownActualSpentUsd: null,
      reason: 'UNKNOWN_ACTUAL_COST' as const,
      settledAmountUsd: null,
    });
  }
  if (compareFixedPrecisionUsd(knownActualSpentUsd, input.reservedAmountUsd) > 0) {
    return Object.freeze({
      action: 'HOLD' as const,
      knownActualSpentUsd,
      reason: 'ACTUAL_COST_OVERRUN' as const,
      settledAmountUsd: null,
    });
  }
  if (!input.providerExecutionOccurred) {
    return Object.freeze({
      action: 'RELEASE' as const,
      knownActualSpentUsd,
      reason: 'NO_PROVIDER_SPEND' as const,
      settledAmountUsd: null,
    });
  }
  return Object.freeze({
    action: 'SETTLE' as const,
    knownActualSpentUsd,
    reason: 'ACTUAL_COST_KNOWN' as const,
    settledAmountUsd: knownActualSpentUsd,
  });
}
