import {
  AiBudgetExecutionClaimStatus,
  AiBudgetReservationStatus,
  type PrismaClient,
} from '../generated/client/client';
import {
  compareFixedPrecisionUsd,
  type FixedPrecisionUsd,
} from '../../services/ai/language-model-pricing';
import { reconcileAiBudgetReservation } from './ai-budget-accounting';
import {
  releaseAiBudgetReservation,
  releaseAiBudgetReservationForConsumption,
  settleAiBudgetReservation,
} from './ai-budget';
import { finishAiBudgetExecutionClaim } from './ai-budget-execution-claims';
import {
  inspectAiBudgetExecutionRecovery,
  inspectWorkspaceAiBudgetExecutionRecovery,
  requireAiBudgetExecutionRecoveryMutationAccess,
  type AiBudgetExecutionRecoveryInspection,
  type AiBudgetExecutionRecoveryInput,
} from './ai-budget-execution-recovery';

export type RecoverAiBudgetExecutionInput = AiBudgetExecutionRecoveryInput;
export type RecoverWorkspaceAiBudgetExecutionInput = Readonly<{
  executionClaimId: string;
  operatorUserId: string;
  workspaceId: string;
}>;

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

type RecoveryReconciliation = Readonly<{
  outcome: 'HELD' | 'RELEASED' | 'SETTLED';
  reservation: Readonly<{
    settledAmountUsd: FixedPrecisionUsd | null;
    status: AiBudgetReservationStatus;
  }>;
}>;
type KnownCostInspection = Extract<
  AiBudgetExecutionRecoveryInspection,
  { classification: 'ATTEMPTED_KNOWN_COST' }
>;
type ZeroAttemptInspection = Extract<
  AiBudgetExecutionRecoveryInspection,
  { classification: 'ZERO_ATTEMPT_PROVEN' }
>;

type AuthorizedRecoveryMutations = Readonly<{
  finish(): Promise<unknown>;
  inspect(): Promise<AiBudgetExecutionRecoveryInspection>;
  reconcile(inspection: KnownCostInspection): Promise<RecoveryReconciliation>;
  release(inspection: ZeroAttemptInspection): Promise<{ status: AiBudgetReservationStatus }>;
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
  reconciliation: RecoveryReconciliation,
  status: AiBudgetReservationStatus,
): boolean {
  return reconciliation.reservation.status === status;
}

async function finishStartedClaim(
  inspection: AiBudgetExecutionRecoveryInspection,
  mutations: AuthorizedRecoveryMutations,
): Promise<AiBudgetExecutionRecoveryActionResult | null> {
  try {
    await mutations.finish();
    return null;
  } catch {
    const refreshed = await mutations.inspect();
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

function createOwnerRecoveryMutations(
  prisma: PrismaClient,
  input: RecoverAiBudgetExecutionInput,
  dependencies: AiBudgetExecutionRecoveryActionDependencies,
): AuthorizedRecoveryMutations {
  return Object.freeze({
    finish: () => (dependencies.finish ?? finishAiBudgetExecutionClaim)(prisma, input),
    inspect: () => inspectAiBudgetExecutionRecovery(prisma, input),
    reconcile: (inspection) =>
      (dependencies.reconcile ?? reconcileAiBudgetReservation)(prisma, {
        actorUserId: input.actorUserId,
        reservationId: inspection.reservation.id,
        routingDecisionId: inspection.routingDecisionId,
        workspaceId: input.workspaceId,
      }),
    release: (inspection) =>
      (dependencies.release ?? releaseAiBudgetReservationForConsumption)(prisma, {
        actorUserId: input.actorUserId,
        reservationId: inspection.reservation.id,
        routingDecisionId: inspection.routingDecisionId,
        workspaceId: input.workspaceId,
      }),
  });
}

function createWorkspaceRecoveryMutations(
  prisma: PrismaClient,
  input: RecoverWorkspaceAiBudgetExecutionInput,
): AuthorizedRecoveryMutations {
  return Object.freeze({
    finish: async () => {
      const transitioned = await prisma.aiBudgetExecutionClaim.updateMany({
        data: { finishedAt: new Date(), status: AiBudgetExecutionClaimStatus.FINISHED },
        where: {
          finishedAt: null,
          id: input.executionClaimId,
          startedAt: { not: null },
          status: AiBudgetExecutionClaimStatus.STARTED,
          workspaceId: input.workspaceId,
        },
      });
      if (transitioned.count !== 1) {
        throw new Error('AI execution claim finish transition was not granted.');
      }
    },
    inspect: () =>
      inspectWorkspaceAiBudgetExecutionRecovery(prisma, {
        actorUserId: input.operatorUserId,
        executionClaimId: input.executionClaimId,
        workspaceId: input.workspaceId,
      }),
    reconcile: async (inspection) => {
      if (
        compareFixedPrecisionUsd(
          inspection.knownAccountedCostUsd,
          inspection.reservation.reservedAmountUsd!,
        ) > 0
      ) {
        return Object.freeze({
          outcome: 'HELD' as const,
          reservation: Object.freeze({
            settledAmountUsd: null,
            status: AiBudgetReservationStatus.RESERVED,
          }),
        });
      }
      const reservation = await settleAiBudgetReservation(prisma, {
        actualCostUsd: inspection.knownAccountedCostUsd,
        actorUserId: input.operatorUserId,
        reservationId: inspection.reservation.id,
        workspaceId: input.workspaceId,
      });
      return Object.freeze({
        outcome: 'SETTLED' as const,
        reservation: Object.freeze({
          settledAmountUsd: inspection.knownAccountedCostUsd,
          status: reservation.status,
        }),
      });
    },
    release: (inspection) =>
      releaseAiBudgetReservation(prisma, {
        actorUserId: input.operatorUserId,
        reservationId: inspection.reservation.id,
        workspaceId: input.workspaceId,
      }),
  });
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
async function recoverAuthoritatively(
  mutations: AuthorizedRecoveryMutations,
): Promise<AiBudgetExecutionRecoveryActionResult> {
  const inspection = await mutations.inspect();

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
    const finishFailure = await finishStartedClaim(inspection, mutations);
    return (
      finishFailure ??
      base(inspection, 'RECOVERED_TERMINAL_FINANCIAL_STATE', AiBudgetExecutionClaimStatus.FINISHED)
    );
  }

  if (inspection.classification === 'ATTEMPTED_UNKNOWN_COST') {
    const finishFailure = await finishStartedClaim(inspection, mutations);
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
    try {
      const reservation = await mutations.release(inspection);
      if (reservation.status !== AiBudgetReservationStatus.RELEASED) {
        return base(inspection, 'RECOVERY_RECONCILIATION_FAILED');
      }
    } catch {
      const refreshed = await mutations.inspect();
      if (refreshed.classification === 'ALREADY_TERMINAL') {
        return base(refreshed, 'RECOVERY_ALREADY_TERMINAL');
      }
      if (
        refreshed.classification === 'TERMINAL_FINANCIAL_STATE' &&
        refreshed.reservation.status === AiBudgetReservationStatus.RELEASED &&
        !terminalFinancialEvidenceConflicts(refreshed)
      ) {
        const finishFailure = await finishStartedClaim(refreshed, mutations);
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
    const finishFailure = await finishStartedClaim(inspection, mutations);
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

  let reconciliation: RecoveryReconciliation;
  try {
    reconciliation = await mutations.reconcile(inspection);
  } catch {
    return base(inspection, 'RECOVERY_RECONCILIATION_FAILED');
  }

  if (
    reconciliation.outcome === 'SETTLED' &&
    reconciliationMatches(reconciliation, AiBudgetReservationStatus.SETTLED)
  ) {
    const finishFailure = await finishStartedClaim(inspection, mutations);
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
    const finishFailure = await finishStartedClaim(inspection, mutations);
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

/**
 * Terminates a stranded claim from persisted evidence. This owner-facing API
 * retains its existing request-owner authorization through its inspection and
 * mutation adapter.
 */
export async function recoverAiBudgetExecution(
  prisma: PrismaClient,
  input: RecoverAiBudgetExecutionInput,
  dependencies: AiBudgetExecutionRecoveryActionDependencies = {},
): Promise<AiBudgetExecutionRecoveryActionResult> {
  return recoverAuthoritatively(createOwnerRecoveryMutations(prisma, input, dependencies));
}

/**
 * Lets a workspace administrator terminally recover a stranded execution
 * owned by another user. It does not impersonate the historical requester:
 * administrative authorization is checked before the shared authoritative
 * recovery state machine runs against workspace-owned evidence.
 */
export async function recoverWorkspaceAiBudgetExecution(
  prisma: PrismaClient,
  input: RecoverWorkspaceAiBudgetExecutionInput,
): Promise<AiBudgetExecutionRecoveryActionResult> {
  await requireAiBudgetExecutionRecoveryMutationAccess(
    prisma,
    input.operatorUserId,
    input.workspaceId,
  );
  return recoverAuthoritatively(createWorkspaceRecoveryMutations(prisma, input));
}
