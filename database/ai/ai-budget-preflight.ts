import {
  AiBudgetReservationStatus,
  type AiRoutingDecision,
  type PrismaClient,
} from '../generated/client/client';
import {
  buildAiExecutionCostPlan,
  type AiExecutionCostPlan,
  type AiExecutionCostPlanInput,
} from '../../services/ai/ai-execution-cost-plan';
import { estimateAiExecutionCost, type AiCostEstimate } from '../../services/ai/ai-cost-estimator';
import { evaluateAiBudget, type AiBudgetDecision } from '../../services/ai/ai-budget-policy';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  AiBudgetInsufficientBalanceError,
  getAiBudgetSnapshotForConsumption,
  getOrCreateAiBudgetAccountForConsumption,
  reserveAiBudgetForConsumption,
  type AiBudgetSnapshot,
} from './ai-budget';
import { getAiRoutingDecisionById } from './ai-routing-decisions';

export type AiBudgetPreflightInput = Readonly<{
  actorUserId: string;
  confirmationThresholdUsd: FixedPrecisionUsd;
  executionPlan: AiExecutionCostPlan | AiExecutionCostPlanInput;
  pricingAt: string;
  reservationIdempotencyKey: string;
  routingDecisionId: string;
  taskHardMaxUsd: FixedPrecisionUsd;
  workspaceId: string;
}>;

type AllowedBudgetDecision = Extract<AiBudgetDecision, Readonly<{ decision: 'ALLOW' }>>;
type ConfirmationBudgetDecision = Extract<
  AiBudgetDecision,
  Readonly<{ decision: 'REQUIRE_CONFIRMATION' }>
>;
type RejectedBudgetDecision = Extract<AiBudgetDecision, Readonly<{ decision: 'REJECT' }>>;

export type AiBudgetPreflightResult =
  | Readonly<{
      budgetDecision: AllowedBudgetDecision;
      estimate: AiCostEstimate;
      outcome: 'ALLOWED';
      reservation: Readonly<{ amountUsd: FixedPrecisionUsd; id: string }>;
    }>
  | Readonly<{
      budgetDecision: ConfirmationBudgetDecision;
      estimate: AiCostEstimate;
      executionPlan: AiExecutionCostPlan;
      outcome: 'CONFIRMATION_REQUIRED';
      reservation: null;
    }>
  | Readonly<{
      budgetDecision: RejectedBudgetDecision;
      estimate: AiCostEstimate;
      outcome: 'REJECTED';
      reservation: null;
    }>
  | Readonly<{
      budgetDecision: AllowedBudgetDecision;
      estimate: AiCostEstimate;
      failureReason: 'SPENDABLE_BALANCE_CHANGED';
      outcome: 'RESERVATION_FAILED';
      reservation: null;
    }>;

export class AiBudgetPreflightError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export type AiBudgetPreflightDependencies = Readonly<{
  getAccount: typeof getOrCreateAiBudgetAccountForConsumption;
  getRoutingDecision: typeof getAiRoutingDecisionById;
  getSnapshot: (
    prisma: PrismaClient,
    actorUserId: string,
    workspaceId: string,
    accountId: string,
  ) => Promise<AiBudgetSnapshot>;
  reserve: typeof reserveAiBudgetForConsumption;
}>;

const defaultDependencies: AiBudgetPreflightDependencies = Object.freeze({
  getAccount: getOrCreateAiBudgetAccountForConsumption,
  getRoutingDecision: getAiRoutingDecisionById,
  getSnapshot: getAiBudgetSnapshotForConsumption,
  reserve: reserveAiBudgetForConsumption,
});

function assertModeMatches(
  routingDecision: AiRoutingDecision,
  executionPlan: AiExecutionCostPlan,
): void {
  if (routingDecision.resolvedMode !== executionPlan.mode) {
    throw new AiBudgetPreflightError(
      'The execution plan does not match the audited routing decision.',
      'budget_preflight_mode_mismatch',
    );
  }
}

function resolveExecutionPlan(
  input: AiExecutionCostPlan | AiExecutionCostPlanInput,
): AiExecutionCostPlan {
  return 'runs' in input ? input : buildAiExecutionCostPlan(input);
}

/**
 * Creates a pre-execution budget coordinator. The injectable persistence boundary
 * exists so lock-race behavior can be tested deterministically; production uses
 * the fixed default dependencies exported as preflightAiBudget.
 */
export function createAiBudgetPreflightService(dependencies: AiBudgetPreflightDependencies) {
  return async function executeAiBudgetPreflight(
    prisma: PrismaClient,
    input: AiBudgetPreflightInput,
  ): Promise<AiBudgetPreflightResult> {
    const executionPlan = resolveExecutionPlan(input.executionPlan);
    const estimate = estimateAiExecutionCost({
      ...executionPlan,
      pricingEffectiveAt: input.pricingAt,
    });
    const routingDecision = await dependencies.getRoutingDecision(
      prisma,
      input.actorUserId,
      input.workspaceId,
      input.routingDecisionId,
    );
    assertModeMatches(routingDecision, executionPlan);

    const account = await dependencies.getAccount(prisma, input.actorUserId, input.workspaceId);
    const snapshot = await dependencies.getSnapshot(
      prisma,
      input.actorUserId,
      input.workspaceId,
      account.id,
    );
    const budgetDecision = evaluateAiBudget({
      alreadyReservedUsd: snapshot.activeReservedUsd,
      availableBalanceUsd: snapshot.ledgerBalanceUsd,
      confirmationThresholdUsd: input.confirmationThresholdUsd,
      estimate,
      taskHardMaxUsd: input.taskHardMaxUsd,
    });

    if (budgetDecision.decision === 'REJECT') {
      return Object.freeze({
        budgetDecision,
        estimate,
        outcome: 'REJECTED' as const,
        reservation: null,
      });
    }
    if (budgetDecision.decision === 'REQUIRE_CONFIRMATION') {
      return Object.freeze({
        budgetDecision,
        estimate,
        executionPlan,
        outcome: 'CONFIRMATION_REQUIRED' as const,
        reservation: null,
      });
    }

    try {
      const reservation = await dependencies.reserve(prisma, {
        accountId: account.id,
        actorUserId: input.actorUserId,
        amountUsd: budgetDecision.proposedReserveUsd,
        idempotencyKey: input.reservationIdempotencyKey,
        routingDecisionId: input.routingDecisionId,
        workspaceId: input.workspaceId,
      });
      if (reservation.status !== AiBudgetReservationStatus.RESERVED) {
        throw new AiBudgetPreflightError(
          'The matching AI budget reservation is no longer active.',
          'budget_preflight_reservation_inactive',
        );
      }
      return Object.freeze({
        budgetDecision,
        estimate,
        outcome: 'ALLOWED' as const,
        reservation: Object.freeze({
          amountUsd: budgetDecision.proposedReserveUsd,
          id: reservation.id,
        }),
      });
    } catch (error) {
      if (error instanceof AiBudgetInsufficientBalanceError) {
        return Object.freeze({
          budgetDecision,
          estimate,
          failureReason: 'SPENDABLE_BALANCE_CHANGED' as const,
          outcome: 'RESERVATION_FAILED' as const,
          reservation: null,
        });
      }
      throw error;
    }
  };
}

export const preflightAiBudget = createAiBudgetPreflightService(defaultDependencies);
