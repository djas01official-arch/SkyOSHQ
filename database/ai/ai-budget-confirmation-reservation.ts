import type { PrismaClient } from '../generated/client/client';
import type { AiCostEstimate } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget, type AiBudgetReason } from '../../services/ai/ai-budget-policy';
import type { AiExecutionCostPlan } from '../../services/ai/ai-execution-cost-plan';
import {
  isFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import {
  AiBudgetInsufficientBalanceError,
  getAiBudgetSnapshotForConsumption,
  getOrCreateAiBudgetAccountForConsumption,
  reserveAiBudgetForConsumption,
} from './ai-budget';
import {
  AiBudgetConfirmationStateError,
  approveAiBudgetConfirmation,
} from './ai-budget-confirmations';
import {
  revalidateAiBudgetConfirmation,
  type AiBudgetConfirmationRevalidationResult,
} from './ai-budget-confirmation-revalidation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INPUT_KEYS = [
  'actorUserId',
  'confirmationId',
  'confirmationThresholdUsd',
  'currentPricingAt',
  'executionPlan',
  'taskHardMaxUsd',
  'workspaceId',
] as const;

export type ApproveAndReserveAiBudgetConfirmationInput = Readonly<{
  actorUserId: string;
  confirmationId: string;
  confirmationThresholdUsd: FixedPrecisionUsd;
  currentPricingAt: string;
  executionPlan: AiExecutionCostPlan;
  taskHardMaxUsd: FixedPrecisionUsd;
  workspaceId: string;
}>;

export type AiApprovedConfirmationReservationResult =
  | Readonly<{
      approvedReserveUsd: FixedPrecisionUsd;
      confirmationId: string;
      costRelation: 'EQUAL' | 'LOWER';
      currentEstimate: AiCostEstimate;
      outcome: 'RESERVED';
      reservationId: string;
      reservedAmountUsd: FixedPrecisionUsd;
      routingDecisionId: string;
    }>
  | Readonly<{
      confirmationId: string;
      outcome: 'CONFIRMATION_REJECTED';
      reservationId: null;
      routingDecisionId: string;
    }>
  | Readonly<{
      confirmationId: string;
      outcome: 'RECONFIRMATION_REQUIRED';
      reason: Extract<
        AiBudgetConfirmationRevalidationResult,
        Readonly<{ outcome: 'RECONFIRMATION_REQUIRED' }>
      >['reason'];
      reservationId: null;
      routingDecisionId: string;
    }>
  | Readonly<{
      confirmationId: string;
      outcome: 'BUDGET_REJECTED';
      reason: Extract<
        AiBudgetReason,
        'UNKNOWN_COST' | 'TASK_HARD_MAX_EXCEEDED' | 'INSUFFICIENT_AVAILABLE_BALANCE'
      >;
      reservationId: null;
      routingDecisionId: string;
    }>
  | Readonly<{
      confirmationId: string;
      outcome: 'RESERVATION_FAILED';
      reason: 'SPENDABLE_BALANCE_CHANGED';
      reservationId: null;
      routingDecisionId: string;
    }>;

export class AiBudgetConfirmationReservationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiBudgetConfirmationReservationStateError extends AiBudgetConfirmationReservationError {}
export class AiBudgetConfirmationReservationValidationError extends AiBudgetConfirmationReservationError {}

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
  throw new AiBudgetConfirmationReservationValidationError(
    'The AI budget confirmation reservation input is invalid.',
    'budget_confirmation_reservation_invalid',
  );
}

function validateInput(input: ApproveAndReserveAiBudgetConfirmationInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, INPUT_KEYS) ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.confirmationId) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !isCanonicalTimestamp(input.currentPricingAt) ||
    !isFixedPrecisionUsd(input.confirmationThresholdUsd) ||
    !isFixedPrecisionUsd(input.taskHardMaxUsd) ||
    !isRecord(input.executionPlan)
  ) {
    invalidInput();
  }
}

function reservationIdempotencyKey(confirmationId: string): string {
  return `ai-budget-confirmation:${confirmationId}`;
}

function confirmationRejected(
  result: Extract<AiBudgetConfirmationRevalidationResult, { outcome: 'NOT_APPROVED' }>,
): AiApprovedConfirmationReservationResult {
  if (result.reason !== 'CONFIRMATION_REJECTED') {
    throw new AiBudgetConfirmationReservationStateError(
      'The AI budget confirmation remains pending after approval.',
      'budget_confirmation_pending',
    );
  }
  return Object.freeze({
    confirmationId: result.confirmationId,
    outcome: 'CONFIRMATION_REJECTED' as const,
    reservationId: null,
    routingDecisionId: result.routingDecisionId,
  });
}

async function approveThenRevalidate(
  prisma: PrismaClient,
  input: ApproveAndReserveAiBudgetConfirmationInput,
): Promise<AiBudgetConfirmationRevalidationResult> {
  const revalidationInput = {
    actorUserId: input.actorUserId,
    confirmationId: input.confirmationId,
    currentPricingAt: input.currentPricingAt,
    executionPlan: input.executionPlan,
    workspaceId: input.workspaceId,
  };
  let result = await revalidateAiBudgetConfirmation(prisma, revalidationInput);
  if (result.outcome !== 'NOT_APPROVED' || result.reason === 'CONFIRMATION_REJECTED') return result;

  try {
    await approveAiBudgetConfirmation(prisma, {
      actorUserId: input.actorUserId,
      confirmationId: input.confirmationId,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    if (!(error instanceof AiBudgetConfirmationStateError)) throw error;
  }
  result = await revalidateAiBudgetConfirmation(prisma, revalidationInput);
  return result;
}

/**
 * Claims one reservation for an approved immutable confirmation. This ends at
 * reservation creation: it never executes, settles, releases, or retries AI.
 */
export async function approveAndReserveAiBudgetConfirmation(
  prisma: PrismaClient,
  input: ApproveAndReserveAiBudgetConfirmationInput,
): Promise<AiApprovedConfirmationReservationResult> {
  validateInput(input);
  const revalidation = await approveThenRevalidate(prisma, input);
  if (revalidation.outcome === 'NOT_APPROVED') return confirmationRejected(revalidation);
  if (revalidation.outcome === 'RECONFIRMATION_REQUIRED') {
    return Object.freeze({ ...revalidation, reservationId: null });
  }

  const account = await getOrCreateAiBudgetAccountForConsumption(
    prisma,
    input.actorUserId,
    input.workspaceId,
  );
  const existing = await prisma.aiBudgetReservation.findFirst({
    where: {
      accountId: account.id,
      routingDecisionId: revalidation.routingDecisionId,
      workspaceId: input.workspaceId,
    },
  });
  if (existing) {
    return Object.freeze({
      approvedReserveUsd: revalidation.approvedReserveUsd,
      confirmationId: revalidation.confirmationId,
      costRelation: revalidation.costRelation,
      currentEstimate: revalidation.currentEstimate,
      outcome: 'RESERVED' as const,
      reservationId: existing.id,
      reservedAmountUsd: existing.reservedAmountUsd.toFixed(12) as FixedPrecisionUsd,
      routingDecisionId: revalidation.routingDecisionId,
    });
  }

  const snapshot = await getAiBudgetSnapshotForConsumption(
    prisma,
    input.actorUserId,
    input.workspaceId,
    account.id,
  );
  const policy = evaluateAiBudget({
    alreadyReservedUsd: snapshot.activeReservedUsd,
    availableBalanceUsd: snapshot.ledgerBalanceUsd,
    confirmationThresholdUsd: input.confirmationThresholdUsd,
    estimate: revalidation.currentEstimate,
    taskHardMaxUsd: input.taskHardMaxUsd,
  });
  if (policy.decision === 'REJECT') {
    return Object.freeze({
      confirmationId: revalidation.confirmationId,
      outcome: 'BUDGET_REJECTED' as const,
      reason: policy.reason,
      reservationId: null,
      routingDecisionId: revalidation.routingDecisionId,
    });
  }

  try {
    const reservation = await reserveAiBudgetForConsumption(prisma, {
      accountId: account.id,
      actorUserId: input.actorUserId,
      amountUsd: revalidation.currentReserveUsd,
      idempotencyKey: reservationIdempotencyKey(revalidation.confirmationId),
      routingDecisionId: revalidation.routingDecisionId,
      workspaceId: input.workspaceId,
    });
    return Object.freeze({
      approvedReserveUsd: revalidation.approvedReserveUsd,
      confirmationId: revalidation.confirmationId,
      costRelation: revalidation.costRelation,
      currentEstimate: revalidation.currentEstimate,
      outcome: 'RESERVED' as const,
      reservationId: reservation.id,
      reservedAmountUsd: reservation.reservedAmountUsd.toFixed(12) as FixedPrecisionUsd,
      routingDecisionId: revalidation.routingDecisionId,
    });
  } catch (error) {
    if (error instanceof AiBudgetInsufficientBalanceError) {
      return Object.freeze({
        confirmationId: revalidation.confirmationId,
        outcome: 'RESERVATION_FAILED' as const,
        reason: 'SPENDABLE_BALANCE_CHANGED' as const,
        reservationId: null,
        routingDecisionId: revalidation.routingDecisionId,
      });
    }
    throw error;
  }
}
