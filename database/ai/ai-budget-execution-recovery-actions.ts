import {
  AiBudgetExecutionClaimStatus,
  AiBudgetReservationStatus,
  type PrismaClient,
} from '../generated/client/client';
import type { FixedPrecisionUsd } from '../../services/ai/language-model-pricing';
import {
  reconcileAiBudgetReservation,
  type AiBudgetReconciliationResult,
} from './ai-budget-accounting';
import { releaseAiBudgetReservationForConsumption } from './ai-budget';
import { finishAiBudgetExecutionClaim } from './ai-budget-execution-claims';
import {
  inspectAiBudgetExecutionRecovery,
  type AiBudgetExecutionRecoveryInspection,
  type AiBudgetExecutionRecoveryInput,
} from './ai-budget-execution-recovery';

export type RecoverAiBudgetExecutionInput = AiBudgetExecutionRecoveryInput;

export type AiBudgetExecutionRecoveryAction =
  | 'RECOVERY_NOT_REQUIRED'
  | 'RECOVERY_ALREADY_TERMINAL'
  | 'RECOVERED_RELEASED_ZERO_ATTEMPT'
  | 'RECOVERED_SETTLED_KNOWN_COST'
  | 'RECOVERED_HELD_KNOWN_COST'
  | 'RECOVERED_HELD_UNKNOWN_COST'
  | 'RECOVERED_TERMINAL_FINANCIAL_STATE'
  | 'RECOVERY_INDETERMINATE'
  | 'RECOVERY_RECONCILIATION_FAILED'
  | 'RECOVERY_CLAIM_FINISH_FAILED';

type AiBudgetExecutionRecoveryActionBase<
  TAction extends AiBudgetExecutionRecoveryAction = AiBudgetExecutionRecoveryAction,
> = Readonly<{
  action: TAction;
  claimId: string;
  finalClaimStatus: AiBudgetExecutionClaimStatus;
  finalReservationStatus: AiBudgetReservationStatus;
  inspection: AiBudgetExecutionRecoveryInspection;
  providerAttemptCount: number;
  reservationId: string;
}>;

export type AiBudgetExecutionRecoveryActionResult =
  | (AiBudgetExecutionRecoveryActionBase<'RECOVERED_SETTLED_KNOWN_COST'> &
      Readonly<{
        action: 'RECOVERED_SETTLED_KNOWN_COST';
        knownAccountedCostUsd: FixedPrecisionUsd;
        settledAmountUsd: FixedPrecisionUsd;
      }>)
  | (AiBudgetExecutionRecoveryActionBase<'RECOVERED_HELD_KNOWN_COST'> &
      Readonly<{
        action: 'RECOVERED_HELD_KNOWN_COST';
        knownAccountedCostUsd: FixedPrecisionUsd;
      }>)
  | (AiBudgetExecutionRecoveryActionBase<'RECOVERED_HELD_UNKNOWN_COST'> &
      Readonly<{
        action: 'RECOVERED_HELD_UNKNOWN_COST';
        knownPartialCostUsd: FixedPrecisionUsd | null;
      }>)
  | AiBudgetExecutionRecoveryActionBase<
      | 'RECOVERY_NOT_REQUIRED'
      | 'RECOVERY_ALREADY_TERMINAL'
      | 'RECOVERED_RELEASED_ZERO_ATTEMPT'
      | 'RECOVERED_TERMINAL_FINANCIAL_STATE'
      | 'RECOVERY_INDETERMINATE'
      | 'RECOVERY_RECONCILIATION_FAILED'
      | 'RECOVERY_CLAIM_FINISH_FAILED'
    >;

/** Injectable only for deterministic persistence-failure regression tests. */
export type AiBudgetExecutionRecoveryActionDependencies = Readonly<{
  finish?: typeof finishAiBudgetExecutionClaim;
  reconcile?: typeof reconcileAiBudgetReservation;
  release?: typeof releaseAiBudgetReservationForConsumption;
}>;

function base<TAction extends AiBudgetExecutionRecoveryAction>(
  inspection: AiBudgetExecutionRecoveryInspection,
  action: TAction,
  finalClaimStatus = inspection.claimStatus,
  finalReservationStatus = inspection.reservation.status,
): AiBudgetExecutionRecoveryActionBase<TAction> {
  return Object.freeze({
    action,
    claimId: inspection.claimId,
    finalClaimStatus,
    finalReservationStatus,
    inspection,
    providerAttemptCount: inspection.providerAttemptCount,
    reservationId: inspection.reservation.id,
  });
}

function reconciliationMatches(
  reconciliation: AiBudgetReconciliationResult,
  status: AiBudgetReservationStatus,
): boolean {
  return reconciliation.reservation.status === status;
}

async function finishStartedClaim(
  prisma: PrismaClient,
  input: RecoverAiBudgetExecutionInput,
  inspection: AiBudgetExecutionRecoveryInspection,
  dependencies: AiBudgetExecutionRecoveryActionDependencies,
): Promise<AiBudgetExecutionRecoveryActionResult | null> {
  const finish = dependencies.finish ?? finishAiBudgetExecutionClaim;
  try {
    await finish(prisma, input);
    return null;
  } catch {
    const refreshed = await inspectAiBudgetExecutionRecovery(prisma, input);
    if (refreshed.classification === 'ALREADY_TERMINAL') {
      return base(
        refreshed,
        'RECOVERY_ALREADY_TERMINAL',
        AiBudgetExecutionClaimStatus.FINISHED,
        refreshed.reservation.status,
      );
    }
    return base(
      inspection,
      'RECOVERY_CLAIM_FINISH_FAILED',
      refreshed.claimStatus,
      refreshed.reservation.status,
    );
  }
}

function terminalFinancialEvidenceConflicts(
  inspection: Extract<
    AiBudgetExecutionRecoveryInspection,
    { classification: 'TERMINAL_FINANCIAL_STATE' }
  >,
): boolean {
  if (inspection.reservation.status === AiBudgetReservationStatus.SETTLED) {
    return inspection.providerAttemptCount === 0;
  }
  if (inspection.reservation.status === AiBudgetReservationStatus.RELEASED) {
    return (
      inspection.unknownCostAttemptedRunCount > 0 ||
      (inspection.providerAttemptCount > 0 && inspection.knownObservedCostUsd !== '0.000000000000')
    );
  }
  return true;
}

/**
 * Terminates a stranded claim from persisted evidence. This service can never
 * grant another execution attempt: it only releases/settles existing money or
 * finishes the existing STARTED claim.
 */
export async function recoverAiBudgetExecution(
  prisma: PrismaClient,
  input: RecoverAiBudgetExecutionInput,
  dependencies: AiBudgetExecutionRecoveryActionDependencies = {},
): Promise<AiBudgetExecutionRecoveryActionResult> {
  const inspection = await inspectAiBudgetExecutionRecovery(prisma, input);

  if (inspection.classification === 'NOT_STARTED') {
    return base(inspection, 'RECOVERY_NOT_REQUIRED');
  }
  if (inspection.classification === 'ALREADY_TERMINAL') {
    return base(inspection, 'RECOVERY_ALREADY_TERMINAL');
  }
  if (inspection.classification === 'INDETERMINATE') {
    return base(inspection, 'RECOVERY_INDETERMINATE');
  }

  if (inspection.classification === 'TERMINAL_FINANCIAL_STATE') {
    if (terminalFinancialEvidenceConflicts(inspection)) {
      return base(inspection, 'RECOVERY_INDETERMINATE');
    }
    const finishFailure = await finishStartedClaim(prisma, input, inspection, dependencies);
    return (
      finishFailure ??
      base(inspection, 'RECOVERED_TERMINAL_FINANCIAL_STATE', AiBudgetExecutionClaimStatus.FINISHED)
    );
  }

  if (inspection.classification === 'ATTEMPTED_UNKNOWN_COST') {
    const finishFailure = await finishStartedClaim(prisma, input, inspection, dependencies);
    return (
      finishFailure ??
      Object.freeze({
        ...base(
          inspection,
          'RECOVERED_HELD_UNKNOWN_COST',
          AiBudgetExecutionClaimStatus.FINISHED,
          AiBudgetReservationStatus.RESERVED,
        ),
        knownPartialCostUsd: inspection.knownPartialCostUsd,
      })
    );
  }

  if (inspection.classification === 'ZERO_ATTEMPT_PROVEN') {
    const release = dependencies.release ?? releaseAiBudgetReservationForConsumption;
    try {
      const reservation = await release(prisma, {
        actorUserId: input.actorUserId,
        reservationId: inspection.reservation.id,
        routingDecisionId: inspection.routingDecisionId,
        workspaceId: input.workspaceId,
      });
      if (reservation.status !== AiBudgetReservationStatus.RELEASED) {
        return base(inspection, 'RECOVERY_RECONCILIATION_FAILED');
      }
    } catch {
      const refreshed = await inspectAiBudgetExecutionRecovery(prisma, input);
      if (refreshed.classification === 'ALREADY_TERMINAL') {
        return base(refreshed, 'RECOVERY_ALREADY_TERMINAL');
      }
      if (
        refreshed.classification === 'TERMINAL_FINANCIAL_STATE' &&
        refreshed.reservation.status === AiBudgetReservationStatus.RELEASED &&
        !terminalFinancialEvidenceConflicts(refreshed)
      ) {
        const finishFailure = await finishStartedClaim(prisma, input, refreshed, dependencies);
        return (
          finishFailure ??
          base(
            refreshed,
            'RECOVERED_TERMINAL_FINANCIAL_STATE',
            AiBudgetExecutionClaimStatus.FINISHED,
            AiBudgetReservationStatus.RELEASED,
          )
        );
      }
      return base(inspection, 'RECOVERY_RECONCILIATION_FAILED');
    }
    const finishFailure = await finishStartedClaim(prisma, input, inspection, dependencies);
    return (
      finishFailure ??
      base(
        inspection,
        'RECOVERED_RELEASED_ZERO_ATTEMPT',
        AiBudgetExecutionClaimStatus.FINISHED,
        AiBudgetReservationStatus.RELEASED,
      )
    );
  }

  const reconcile = dependencies.reconcile ?? reconcileAiBudgetReservation;
  let reconciliation: AiBudgetReconciliationResult;
  try {
    reconciliation = await reconcile(prisma, {
      actorUserId: input.actorUserId,
      reservationId: inspection.reservation.id,
      routingDecisionId: inspection.routingDecisionId,
      workspaceId: input.workspaceId,
    });
  } catch {
    return base(inspection, 'RECOVERY_RECONCILIATION_FAILED');
  }

  if (
    reconciliation.outcome === 'SETTLED' &&
    reconciliationMatches(reconciliation, AiBudgetReservationStatus.SETTLED)
  ) {
    const finishFailure = await finishStartedClaim(prisma, input, inspection, dependencies);
    return (
      finishFailure ??
      Object.freeze({
        ...base(
          inspection,
          'RECOVERED_SETTLED_KNOWN_COST',
          AiBudgetExecutionClaimStatus.FINISHED,
          AiBudgetReservationStatus.SETTLED,
        ),
        knownAccountedCostUsd: inspection.knownAccountedCostUsd,
        settledAmountUsd: reconciliation.reservation.settledAmountUsd!,
      })
    );
  }
  if (
    reconciliation.outcome === 'HELD' &&
    reconciliationMatches(reconciliation, AiBudgetReservationStatus.RESERVED)
  ) {
    const finishFailure = await finishStartedClaim(prisma, input, inspection, dependencies);
    return (
      finishFailure ??
      Object.freeze({
        ...base(
          inspection,
          'RECOVERED_HELD_KNOWN_COST',
          AiBudgetExecutionClaimStatus.FINISHED,
          AiBudgetReservationStatus.RESERVED,
        ),
        knownAccountedCostUsd: inspection.knownAccountedCostUsd,
      })
    );
  }
  return base(inspection, 'RECOVERY_RECONCILIATION_FAILED');
}
