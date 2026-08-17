import { AiBudgetConfirmationStatus, type PrismaClient } from '../generated/client/client';
import { estimateAiExecutionCost, type AiCostEstimate } from '../../services/ai/ai-cost-estimator';
import type { AiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
import {
  AiBudgetProposalFingerprintValidationError,
  fingerprintAiBudgetExecutionPlan,
  fingerprintAiBudgetProposal,
} from '../../services/ai/ai-budget-proposal-fingerprint';
import {
  compareFixedPrecisionUsd,
  isFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  AiRoutingDecisionAuthorizationError,
  AiRoutingDecisionNotFoundError,
  getAiRoutingDecisionById,
} from './ai-routing-decisions';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INPUT_KEYS = [
  'actorUserId',
  'confirmationId',
  'currentPricingAt',
  'executionPlan',
  'workspaceId',
] as const;

export type RevalidateAiBudgetConfirmationInput = Readonly<{
  actorUserId: string;
  confirmationId: string;
  currentPricingAt: string;
  executionPlan: AiExecutionCostPlan;
  workspaceId: string;
}>;

export type AiBudgetConfirmationRevalidationResult =
  | Readonly<{
      approvedReserveUsd: FixedPrecisionUsd;
      confirmationId: string;
      costRelation: 'EQUAL' | 'LOWER';
      currentEstimate: AiCostEstimate;
      currentReserveUsd: FixedPrecisionUsd;
      outcome: 'VALID_FOR_RESERVATION';
      routingDecisionId: string;
    }>
  | Readonly<{
      confirmationId: string;
      outcome: 'NOT_APPROVED';
      reason: 'CONFIRMATION_PENDING' | 'CONFIRMATION_REJECTED';
      routingDecisionId: string;
    }>
  | Readonly<{
      confirmationId: string;
      outcome: 'RECONFIRMATION_REQUIRED';
      reason:
        | 'APPROVED_PROPOSAL_CHANGED'
        | 'APPROVED_PROPOSAL_UNRECONSTRUCTABLE'
        | 'CURRENT_COST_EXCEEDS_APPROVED_AMOUNT'
        | 'CURRENT_COST_UNKNOWN'
        | 'EXECUTION_PLAN_CHANGED';
      routingDecisionId: string;
    }>;

export class AiBudgetConfirmationRevalidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetConfirmationRevalidationAuthorizationError extends AiBudgetConfirmationRevalidationError {}
export class AiBudgetConfirmationRevalidationNotFoundError extends AiBudgetConfirmationRevalidationError {}
export class AiBudgetConfirmationRevalidationValidationError extends AiBudgetConfirmationRevalidationError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalidInput(): never {
  throw new AiBudgetConfirmationRevalidationValidationError(
    'The AI budget confirmation revalidation input is invalid.',
    'budget_confirmation_revalidation_invalid',
  );
}

function validateInput(input: RevalidateAiBudgetConfirmationInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, INPUT_KEYS) ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.confirmationId) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !isCanonicalTimestamp(input.currentPricingAt) ||
    !isRecord(input.executionPlan)
  ) {
    invalidInput();
  }
}

function confirmationMoney(value: { toFixed(decimalPlaces: number): string }): FixedPrecisionUsd {
  const formatted = value.toFixed(12);
  if (!isFixedPrecisionUsd(formatted)) {
    throw new AiBudgetConfirmationRevalidationValidationError(
      'The stored AI budget confirmation amount is invalid.',
      'budget_confirmation_revalidation_state_invalid',
    );
  }
  return formatted;
}

function reconfirmation(
  confirmationId: string,
  routingDecisionId: string,
  reason: Extract<
    AiBudgetConfirmationRevalidationResult,
    Readonly<{ outcome: 'RECONFIRMATION_REQUIRED' }>
  >['reason'],
): AiBudgetConfirmationRevalidationResult {
  return Object.freeze({
    confirmationId,
    outcome: 'RECONFIRMATION_REQUIRED' as const,
    reason,
    routingDecisionId,
  });
}

function estimate(executionPlan: AiExecutionCostPlan, pricingEffectiveAt: string): AiCostEstimate {
  return estimateAiExecutionCost({ ...executionPlan, pricingEffectiveAt });
}

/**
 * Reads an approved confirmation and proves that a reconstructed plan is still
 * the exact proposal approved by its owner. It deliberately does not reserve,
 * settle, mutate persistence, or execute a provider.
 */
export async function revalidateAiBudgetConfirmation(
  prisma: PrismaClient,
  input: RevalidateAiBudgetConfirmationInput,
): Promise<AiBudgetConfirmationRevalidationResult> {
  validateInput(input);
  const confirmation = await prisma.aiBudgetConfirmation.findFirst({
    where: {
      id: input.confirmationId,
      requestedByUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    },
  });
  if (!confirmation) {
    throw new AiBudgetConfirmationRevalidationNotFoundError(
      'The AI budget confirmation was not found for this user and workspace.',
      'budget_confirmation_revalidation_not_found',
    );
  }

  let routingDecision: Awaited<ReturnType<typeof getAiRoutingDecisionById>>;
  try {
    routingDecision = await getAiRoutingDecisionById(
      prisma,
      input.actorUserId,
      input.workspaceId,
      confirmation.routingDecisionId,
    );
  } catch (error) {
    if (error instanceof AiRoutingDecisionAuthorizationError) {
      throw new AiBudgetConfirmationRevalidationAuthorizationError(
        'AI budget confirmation revalidation requires ai.use in the selected workspace.',
        'budget_confirmation_revalidation_forbidden',
      );
    }
    if (error instanceof AiRoutingDecisionNotFoundError) {
      throw new AiBudgetConfirmationRevalidationNotFoundError(
        'The AI routing decision was not found for this user and workspace.',
        'budget_confirmation_revalidation_routing_not_found',
      );
    }
    throw error;
  }

  if (confirmation.status === AiBudgetConfirmationStatus.PENDING) {
    return Object.freeze({
      confirmationId: confirmation.id,
      outcome: 'NOT_APPROVED' as const,
      reason: 'CONFIRMATION_PENDING' as const,
      routingDecisionId: routingDecision.id,
    });
  }
  if (confirmation.status === AiBudgetConfirmationStatus.REJECTED) {
    return Object.freeze({
      confirmationId: confirmation.id,
      outcome: 'NOT_APPROVED' as const,
      reason: 'CONFIRMATION_REJECTED' as const,
      routingDecisionId: routingDecision.id,
    });
  }

  let executionPlanFingerprint: string;
  try {
    executionPlanFingerprint = fingerprintAiBudgetExecutionPlan(input.executionPlan);
  } catch (error) {
    if (error instanceof AiBudgetProposalFingerprintValidationError) {
      return reconfirmation(confirmation.id, routingDecision.id, 'EXECUTION_PLAN_CHANGED');
    }
    throw error;
  }
  if (
    input.executionPlan.mode !== routingDecision.resolvedMode ||
    executionPlanFingerprint !== confirmation.executionPlanFingerprint
  ) {
    return reconfirmation(confirmation.id, routingDecision.id, 'EXECUTION_PLAN_CHANGED');
  }

  const approvedReserveUsd = confirmationMoney(confirmation.proposedReserveUsd);
  const approvedPricingAt = confirmation.pricingAt.toISOString();
  let approvedBasisEstimate: AiCostEstimate;
  let approvedBasisFingerprint: string;
  try {
    approvedBasisEstimate = estimate(input.executionPlan, approvedPricingAt);
    if (approvedBasisEstimate.hasUnknownCost) {
      return reconfirmation(
        confirmation.id,
        routingDecision.id,
        'APPROVED_PROPOSAL_UNRECONSTRUCTABLE',
      );
    }
    approvedBasisFingerprint = fingerprintAiBudgetProposal({
      estimate: approvedBasisEstimate,
      executionPlan: input.executionPlan,
    }).estimateFingerprint;
  } catch {
    return reconfirmation(
      confirmation.id,
      routingDecision.id,
      'APPROVED_PROPOSAL_UNRECONSTRUCTABLE',
    );
  }
  if (
    approvedBasisFingerprint !== confirmation.estimateFingerprint ||
    compareFixedPrecisionUsd(approvedBasisEstimate.knownEstimatedCostUsd, approvedReserveUsd) !== 0
  ) {
    return reconfirmation(confirmation.id, routingDecision.id, 'APPROVED_PROPOSAL_CHANGED');
  }

  let currentEstimate: AiCostEstimate;
  try {
    currentEstimate = estimate(input.executionPlan, input.currentPricingAt);
  } catch {
    return reconfirmation(confirmation.id, routingDecision.id, 'CURRENT_COST_UNKNOWN');
  }
  if (currentEstimate.hasUnknownCost) {
    return reconfirmation(confirmation.id, routingDecision.id, 'CURRENT_COST_UNKNOWN');
  }
  const currentReserveUsd = currentEstimate.knownEstimatedCostUsd;
  const relation = compareFixedPrecisionUsd(currentReserveUsd, approvedReserveUsd);
  if (relation > 0) {
    return reconfirmation(
      confirmation.id,
      routingDecision.id,
      'CURRENT_COST_EXCEEDS_APPROVED_AMOUNT',
    );
  }
  return Object.freeze({
    approvedReserveUsd,
    confirmationId: confirmation.id,
    costRelation: relation === 0 ? 'EQUAL' : 'LOWER',
    currentEstimate,
    currentReserveUsd,
    outcome: 'VALID_FOR_RESERVATION' as const,
    routingDecisionId: routingDecision.id,
  });
}
