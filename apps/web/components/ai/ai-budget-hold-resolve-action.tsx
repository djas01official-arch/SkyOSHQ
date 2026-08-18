'use client';

import { useActionState } from 'react';

import type { AiBudgetHoldResolutionClassification } from '../../../../database/ai/ai-budget-hold-resolution';
import {
  resolveBudgetHoldAction,
  type AiBudgetHoldResolveActionState,
} from '@/app/ai/holds/actions';
import { Button } from '@/components/ui/button';

const initialState: AiBudgetHoldResolveActionState = { error: null, notice: null };

type AiBudgetHoldResolveActionProps = Readonly<{
  classification: AiBudgetHoldResolutionClassification;
  reservationId: string;
}>;

function canResolve(classification: AiBudgetHoldResolutionClassification): boolean {
  return (
    classification === 'RESOLVABLE_RELEASE_ZERO_ATTEMPT' ||
    classification === 'RESOLVABLE_SETTLE_KNOWN_COST'
  );
}

function descriptionFor(classification: AiBudgetHoldResolutionClassification): string {
  switch (classification) {
    case 'RESOLVABLE_RELEASE_ZERO_ATTEMPT':
      return 'Persisted evidence proves no provider attempt occurred. Resolving will release the held budget.';
    case 'RESOLVABLE_SETTLE_KNOWN_COST':
      return 'All attempted provider costs are known. Resolving will reconcile the exact persisted accounted cost.';
    case 'BLOCKED_UNKNOWN_COST':
      return 'At least one attempted provider execution still lacks authoritative persisted cost. SkyOS will keep this budget held.';
    case 'BLOCKED_OVERRUN':
      return 'Recorded provider cost is above the reserved amount. Automatic resolution is blocked.';
    case 'INDETERMINATE':
      return 'Persisted financial or execution evidence is incomplete or contradictory, so SkyOS will not modify this hold automatically.';
    case 'NOT_HELD':
    case 'ALREADY_RESOLVED':
      return 'This reservation is no longer a current budget hold.';
  }
}

/**
 * Presentation classification controls only whether a control is shown. The
 * action itself submits one reservation ID and always re-inspects persisted
 * evidence before it can change financial state.
 */
export function AiBudgetHoldResolveAction({
  classification,
  reservationId,
}: AiBudgetHoldResolveActionProps) {
  const [state, formAction, pending] = useActionState(resolveBudgetHoldAction, initialState);
  const resolvable = canResolve(classification);

  return (
    <div className="mt-5 border-t border-border pt-5">
      <p className="text-sm leading-6 text-muted-foreground">{descriptionFor(classification)}</p>
      {resolvable ? (
        <form
          action={formAction}
          className="mt-3 flex flex-wrap items-center gap-3"
          data-ai-budget-hold-action="resolve"
        >
          <input name="reservationId" type="hidden" value={reservationId} />
          <Button
            aria-label="Resolve this budget hold"
            disabled={pending}
            size="small"
            type="submit"
            variant="secondary"
          >
            {pending ? 'Resolving…' : 'Resolve'}
          </Button>
        </form>
      ) : (
        <p className="mt-3 text-sm font-medium text-muted-foreground" role="status">
          {classification === 'INDETERMINATE'
            ? 'Manual investigation required.'
            : 'Automatic resolution is not currently available.'}
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
