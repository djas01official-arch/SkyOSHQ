import type { AiCostEstimate } from './ai-cost-estimator';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  subtractFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from './language-model-pricing';

export const AI_BUDGET_DECISIONS = ['ALLOW', 'REQUIRE_CONFIRMATION', 'REJECT'] as const;
export type AiBudgetDecisionKey = (typeof AI_BUDGET_DECISIONS)[number];

export const AI_BUDGET_REASONS = [
  'WITHIN_BUDGET',
  'CONFIRMATION_THRESHOLD_REACHED',
  'UNKNOWN_COST',
  'TASK_HARD_MAX_EXCEEDED',
  'INSUFFICIENT_AVAILABLE_BALANCE',
] as const;
export type AiBudgetReason = (typeof AI_BUDGET_REASONS)[number];

export type AiBudgetPolicyInput = Readonly<{
  alreadyReservedUsd: FixedPrecisionUsd;
  availableBalanceUsd: FixedPrecisionUsd;
  confirmationThresholdUsd: FixedPrecisionUsd;
  estimate: AiCostEstimate;
  taskHardMaxUsd: FixedPrecisionUsd;
}>;

type AiBudgetApprovedDecision = Readonly<{
  decision: 'ALLOW';
  proposedReserveUsd: FixedPrecisionUsd;
  reason: 'WITHIN_BUDGET';
  spendableBalanceUsd: FixedPrecisionUsd;
}>;

type AiBudgetConfirmationDecision = Readonly<{
  decision: 'REQUIRE_CONFIRMATION';
  proposedReserveUsd: FixedPrecisionUsd;
  reason: 'CONFIRMATION_THRESHOLD_REACHED';
  spendableBalanceUsd: FixedPrecisionUsd;
}>;

type AiBudgetRejectedDecision = Readonly<{
  decision: 'REJECT';
  proposedReserveUsd: FixedPrecisionUsd | null;
  reason: 'UNKNOWN_COST' | 'TASK_HARD_MAX_EXCEEDED' | 'INSUFFICIENT_AVAILABLE_BALANCE';
  spendableBalanceUsd: FixedPrecisionUsd;
}>;

export type AiBudgetDecision =
  AiBudgetApprovedDecision | AiBudgetConfirmationDecision | AiBudgetRejectedDecision;

export class AiBudgetPolicyValidationError extends Error {
  readonly code = 'budget_policy_input_invalid';
}

const INPUT_KEYS = [
  'alreadyReservedUsd',
  'availableBalanceUsd',
  'confirmationThresholdUsd',
  'estimate',
  'taskHardMaxUsd',
] as const;

function validateInput(input: AiBudgetPolicyInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AiBudgetPolicyValidationError('The AI budget policy input is invalid.');
  }
  const candidate = input as unknown as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== INPUT_KEYS.length ||
    !Object.keys(candidate).every((key) =>
      INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]),
    ) ||
    !isFixedPrecisionUsd(candidate.availableBalanceUsd) ||
    !isFixedPrecisionUsd(candidate.alreadyReservedUsd) ||
    !isFixedPrecisionUsd(candidate.taskHardMaxUsd) ||
    !isFixedPrecisionUsd(candidate.confirmationThresholdUsd) ||
    typeof candidate.estimate !== 'object' ||
    candidate.estimate === null ||
    Array.isArray(candidate.estimate)
  ) {
    throw new AiBudgetPolicyValidationError('The AI budget policy input is invalid.');
  }

  const estimate = candidate.estimate as Record<string, unknown>;
  if (
    !isFixedPrecisionUsd(estimate.knownEstimatedCostUsd) ||
    typeof estimate.hasUnknownCost !== 'boolean' ||
    !Number.isSafeInteger(estimate.unknownCostRunCount) ||
    Number(estimate.unknownCostRunCount) < 0 ||
    estimate.hasUnknownCost !== Number(estimate.unknownCostRunCount) > 0 ||
    compareFixedPrecisionUsd(candidate.alreadyReservedUsd, candidate.availableBalanceUsd) > 0
  ) {
    throw new AiBudgetPolicyValidationError('The AI budget policy input is invalid.');
  }
}

function reject(
  reason: AiBudgetRejectedDecision['reason'],
  proposedReserveUsd: FixedPrecisionUsd | null,
  spendableBalanceUsd: FixedPrecisionUsd,
): AiBudgetRejectedDecision {
  return Object.freeze({ decision: 'REJECT', proposedReserveUsd, reason, spendableBalanceUsd });
}

/**
 * Evaluates a fully planned cost without reserving funds or performing I/O.
 * Hard-max and balance equality are permitted; confirmation equality requires confirmation.
 */
export function evaluateAiBudget(input: AiBudgetPolicyInput): AiBudgetDecision {
  validateInput(input);
  const spendableBalanceUsd = subtractFixedPrecisionUsd(
    input.availableBalanceUsd,
    input.alreadyReservedUsd,
  );

  if (input.estimate.hasUnknownCost) {
    return reject('UNKNOWN_COST', null, spendableBalanceUsd);
  }

  const proposedReserveUsd = input.estimate.knownEstimatedCostUsd;
  if (compareFixedPrecisionUsd(proposedReserveUsd, input.taskHardMaxUsd) > 0) {
    return reject('TASK_HARD_MAX_EXCEEDED', proposedReserveUsd, spendableBalanceUsd);
  }
  if (compareFixedPrecisionUsd(proposedReserveUsd, spendableBalanceUsd) > 0) {
    return reject('INSUFFICIENT_AVAILABLE_BALANCE', proposedReserveUsd, spendableBalanceUsd);
  }
  if (compareFixedPrecisionUsd(proposedReserveUsd, input.confirmationThresholdUsd) >= 0) {
    return Object.freeze({
      decision: 'REQUIRE_CONFIRMATION',
      proposedReserveUsd,
      reason: 'CONFIRMATION_THRESHOLD_REACHED',
      spendableBalanceUsd,
    });
  }
  return Object.freeze({
    decision: 'ALLOW',
    proposedReserveUsd,
    reason: 'WITHIN_BUDGET',
    spendableBalanceUsd,
  });
}
