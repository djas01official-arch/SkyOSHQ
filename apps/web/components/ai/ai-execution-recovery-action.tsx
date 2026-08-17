'use client';

import React, { useActionState } from 'react';

import type { AiBudgetExecutionRecoveryClassification } from '../../../../database/ai/ai-budget-execution-recovery';
import {
  recoverExecutionAction,
  type AiExecutionRecoveryActionState,
} from '@/app/ai/recovery/actions';
import { Button } from '@/components/ui/button';

const initialState: AiExecutionRecoveryActionState = { error: null, notice: null };

type AiExecutionRecoveryActionProps = Readonly<{
  classification: AiBudgetExecutionRecoveryClassification;
  executionClaimId: string;
}>;

function descriptionFor(classification: AiExecutionRecoveryActionProps['classification']): string {
  switch (classification) {
    case 'NOT_STARTED':
    case 'ALREADY_TERMINAL':
      return 'This execution no longer requires recovery.';
    case 'ZERO_ATTEMPT_PROVEN':
      return 'This will release the reserved budget and close this execution claim. It will not run the AI request.';
    case 'ATTEMPTED_KNOWN_COST':
      return 'Recovery will reconcile the persisted provider cost and close execution ownership.';
    case 'ATTEMPTED_UNKNOWN_COST':
      return 'Provider execution was attempted, but complete cost is unresolved. Recovery will close execution ownership and hold the budget for later financial review.';
    case 'TERMINAL_FINANCIAL_STATE':
      return 'Financial reconciliation is already terminal. Recovery will close the remaining execution ownership state.';
    case 'INDETERMINATE':
      return 'Persisted execution evidence is insufficient or contradictory, so SkyOS will not modify this execution automatically.';
  }
}

export function AiExecutionRecoveryAction({
  classification,
  executionClaimId,
}: AiExecutionRecoveryActionProps) {
  const [state, formAction, pending] = useActionState(recoverExecutionAction, initialState);
  const canRecover = [
    'ZERO_ATTEMPT_PROVEN',
    'ATTEMPTED_KNOWN_COST',
    'ATTEMPTED_UNKNOWN_COST',
    'TERMINAL_FINANCIAL_STATE',
  ].includes(classification);

  return (
    <div className="mt-5 border-t border-border pt-5">
      <p className="text-sm leading-6 text-muted-foreground">{descriptionFor(classification)}</p>
      {canRecover ? (
        <form
          action={formAction}
          className="mt-3 flex flex-wrap items-center gap-3"
          data-ai-recovery-action="recover"
        >
          <input name="executionClaimId" type="hidden" value={executionClaimId} />
          <Button
            aria-label="Recover this AI execution"
            disabled={pending}
            size="small"
            type="submit"
            variant="secondary"
          >
            {pending ? 'Recovering…' : 'Recover'}
          </Button>
        </form>
      ) : (
        <p className="mt-3 text-sm font-medium text-muted-foreground" role="status">
          Manual investigation required.
        </p>
      )}
      {state.notice ? (
        <p
          aria-live="polite"
          className="mt-3 text-sm leading-6 text-muted-foreground"
          role="status"
        >
          {state.notice}
        </p>
      ) : null}
      {state.error ? (
        <p aria-live="polite" className="mt-3 text-sm leading-6 text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
